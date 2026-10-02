import path from "node:path";
import { hash, isRecord, lexicalCompare, stableJson } from "./agent-files.ts";
import { parseSkillDocument, type PackagedSkill } from "./tuning.ts";
import {
  DEFAULT_SHERPA_SKILL_SOURCES,
  type SherpaSkillSource,
  type SherpaSkillSourceEntry,
} from "./skill-source-catalog.ts";
import {
  createSourcePathNamespace,
  listCachedFiles,
  resolvePinnedSource,
  safeCachedPath,
  verifyCachedFile,
  type CachedSource,
  type PinnedSourceSelection,
  type SourceCacheOptions,
} from "./source-cache.ts";

const NAMESPACE_OR_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const FULL_COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu;
const MAX_SKILL_FILES = 20_000;
const MAX_SKILL_BYTES = 256 * 1024 * 1024;
const RESERVED_ROOT_FILES = new Set(["sherpa-source.json", "sherpa-license.txt"]);
const FILE_MAP_BYTES = new WeakMap<Map<string, Buffer>, number>();
const FILE_MAP_PATHS = new WeakMap<Map<string, Buffer>, ReturnType<typeof createSourcePathNamespace>>();

export type { SherpaSkillSource, SherpaSkillSourceEntry } from "./skill-source-catalog.ts";

export interface SherpaSkillSourceInfo {
  readonly namespace: string;
  readonly repository: string;
  readonly commit: string;
  readonly archiveSha256: string;
  readonly skills: readonly {
    readonly id: string;
    readonly sourcePath: string;
    readonly licenseEvidence: SherpaSkillLicenseEvidence;
  }[];
}

export type SherpaSkillLicenseEvidence =
  | { readonly kind: "file"; readonly path: string; readonly sha256: string }
  | { readonly kind: "declared"; readonly identifier: string };

export interface SherpaSkillDiagnostic {
  readonly namespace: string;
  readonly repository: string;
  readonly commit: string;
  readonly code: "source-unavailable" | "missing-skill" | "invalid-skill" | "invalid-license";
  readonly message: string;
  readonly skillId?: string;
  readonly sourcePath?: string;
}

export interface SherpaSkillResolution {
  readonly skills: readonly PackagedSkill[];
  readonly sources: readonly SherpaSkillSourceInfo[];
  readonly diagnostics: readonly SherpaSkillDiagnostic[];
}

export interface SherpaSkillSourceOptions extends SourceCacheOptions {
  readonly skillIds?: readonly string[];
}

interface ValidatedEntry extends SherpaSkillSourceEntry {
  readonly targetId: string;
  readonly supportPaths?: readonly string[];
}

interface ValidatedSkillSource extends SherpaSkillSource {
  readonly namespace: string;
  readonly repository: string;
  readonly commit: string;
  readonly skills: readonly ValidatedEntry[];
  readonly licensePath?: string;
  readonly license?: string;
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(record).find((key) => !allowed.includes(key));
  if (unknown) throw new TypeError(`Unsupported ${label} field '${unknown}'.`);
}

function validPath(value: unknown, label: string, source: string): string {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0") ||
    value.startsWith("/") || /^[A-Za-z]:/u.test(value) || /[*?{}\[\]]/u.test(value)) {
    throw new TypeError(`Invalid ${label} '${String(value)}' in skill source '${source}'.`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new TypeError(`Unsafe ${label} '${value}' in skill source '${source}'.`);
  }
  return value;
}

function validateRepository(repository: unknown, namespace: string): string {
  if (typeof repository !== "string" || !repository.trim()) {
    throw new TypeError(`Skill source '${namespace}' requires a repository string.`);
  }
  const value = repository.trim();
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value)) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`Invalid GitHub repository descriptor in skill source '${namespace}'.`);
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.search || url.hash ||
    url.username || url.password || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/u.test(url.pathname)) {
    throw new TypeError(`Only owner/repository and HTTPS github.com URLs are supported for skill source '${namespace}'.`);
  }
  return value;
}

function validateSkillSources(value: unknown): readonly ValidatedSkillSource[] {
  if (!Array.isArray(value)) throw new TypeError("skillSources must be an array.");
  const namespaces = new Set<string>();
  const targets = new Set<string>();
  const validated = value.map((rawSource, sourceIndex): ValidatedSkillSource => {
    if (!isRecord(rawSource)) throw new TypeError(`Skill source at index ${sourceIndex} must be an object.`);
    hasOnlyKeys(rawSource, ["namespace", "repository", "commit", "licensePath", "license", "skills"], "skill source");
    const { namespace, repository, commit, skills } = rawSource;
    if (typeof namespace !== "string" || !NAMESPACE_OR_ID.test(namespace)) {
      throw new TypeError(`Invalid skill source namespace '${String(namespace)}'.`);
    }
    if (namespaces.has(namespace)) throw new TypeError(`Duplicate skill source namespace '${namespace}'.`);
    namespaces.add(namespace);
    const canonicalRepository = validateRepository(repository, namespace);
    if (typeof commit !== "string" || !FULL_COMMIT.test(commit)) {
      throw new TypeError(`Skill source '${namespace}' requires an immutable full commit SHA.`);
    }
    const hasLicensePath = Object.hasOwn(rawSource, "licensePath");
    const hasLicense = Object.hasOwn(rawSource, "license");
    if (hasLicensePath === hasLicense) {
      throw new TypeError(`Skill source '${namespace}' requires exactly one of licensePath or license.`);
    }
    let licensePath: string | undefined;
    let license: string | undefined;
    if (hasLicensePath) licensePath = validPath(rawSource.licensePath, "licensePath", namespace);
    else if (typeof rawSource.license === "string" && rawSource.license.trim()) license = rawSource.license;
    else throw new TypeError(`Skill source '${namespace}' license must be a non-empty string.`);
    if (!Array.isArray(skills) || skills.length === 0) {
      throw new TypeError(`Skill source '${namespace}' requires one or more skills.`);
    }
    const sourceEntryIds = new Set<string>();
    const entries = skills.map((rawEntry, entryIndex): ValidatedEntry => {
      if (!isRecord(rawEntry)) throw new TypeError(`Skill entry ${entryIndex} in '${namespace}' must be an object.`);
      hasOnlyKeys(rawEntry, ["id", "path", "supportPaths"], "skill entry");
      const { id } = rawEntry;
      if (typeof id !== "string" || !NAMESPACE_OR_ID.test(id)) {
        throw new TypeError(`Invalid skill ID '${String(id)}' in source '${namespace}'.`);
      }
      if (sourceEntryIds.has(id)) throw new TypeError(`Duplicate skill ID '${id}' in source '${namespace}'.`);
      sourceEntryIds.add(id);
      const targetId = `sherpa-${namespace}-${id}`;
      if (targets.has(targetId)) throw new TypeError(`Duplicate declared skill ID '${targetId}'.`);
      targets.add(targetId);
      const sourcePath = validPath(rawEntry.path, "skill path", namespace);
      if (path.posix.basename(sourcePath) !== "SKILL.md") {
        throw new TypeError(`Skill path must name exact SKILL.md: '${sourcePath}'.`);
      }
      const hasSupportPaths = Object.hasOwn(rawEntry, "supportPaths");
      if (path.posix.dirname(sourcePath) === "." && !hasSupportPaths) {
        throw new TypeError(`Root skill '${targetId}' requires explicit supportPaths, including an empty array.`);
      }
      let supportPaths: readonly string[] | undefined;
      if (hasSupportPaths) {
        if (!Array.isArray(rawEntry.supportPaths) || rawEntry.supportPaths.some((item) => typeof item !== "string")) {
          throw new TypeError(`Skill '${targetId}' supportPaths must be an array of relative paths.`);
        }
        const seenPaths = new Set<string>();
        const paths = rawEntry.supportPaths.map((item) => {
          const safe = validPath(item, "support path", namespace);
          if (seenPaths.has(safe)) throw new TypeError(`Duplicate support path '${safe}' in skill '${targetId}'.`);
          seenPaths.add(safe);
          return safe;
        });
        supportPaths = Object.freeze(paths);
      }
      const validatedEntry = {
        id,
        path: sourcePath,
        ...(supportPaths === undefined ? {} : { supportPaths }),
      } as ValidatedEntry;
      Object.defineProperty(validatedEntry, "targetId", { value: targetId, enumerable: false });
      return Object.freeze(validatedEntry);
    });
    return Object.freeze({
      namespace,
      repository: canonicalRepository,
      commit: commit.toLowerCase(),
      ...(licensePath === undefined ? {} : { licensePath }),
      ...(license === undefined ? {} : { license }),
      skills: Object.freeze(entries),
    });
  });
  return Object.freeze(validated);
}

export function configuredSherpaSkillSources(value: unknown): readonly SherpaSkillSource[] {
  let sources: unknown;
  if (value === undefined) sources = DEFAULT_SHERPA_SKILL_SOURCES;
  else if (Array.isArray(value)) sources = value;
  else {
    if (!isRecord(value)) throw new TypeError("skillSources must be an array or an object with a sources array.");
    hasOnlyKeys(value, ["sources", "includeDefaults"], "skillSources configuration");
    if (!Array.isArray(value.sources) ||
      (value.includeDefaults !== undefined && typeof value.includeDefaults !== "boolean")) {
      throw new TypeError("skillSources must be an array or an object with a sources array and optional includeDefaults boolean.");
    }
    sources = [
      ...(value.includeDefaults === false ? [] : DEFAULT_SHERPA_SKILL_SOURCES),
      ...value.sources,
    ];
  }
  return validateSkillSources(sources);
}

export function declaredSkillIds(sources: readonly SherpaSkillSource[]): readonly string[] {
  return Object.freeze(validateSkillSources(sources).flatMap((source) => source.skills.map((entry) => entry.targetId)));
}

function addFile(files: Map<string, Buffer>, relative: string, bytes: Buffer, generated = false): void {
  if (!relative || relative.includes("\0") || relative.includes("\\") || relative.startsWith("/") ||
    /^[A-Za-z]:/u.test(relative) || /[*?{}\[\]]/u.test(relative) ||
    relative.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`Unsafe packaged skill file path: ${relative}`);
  }
  const key = relative.toLowerCase();
  if (!generated && RESERVED_ROOT_FILES.has(key.split("/")[0]!)) {
    throw new Error(`Upstream skill collides with reserved Sherpa file: ${relative}`);
  }
  const hadFile = files.has(relative);
  const existing = files.get(relative);
  if (existing && !existing.equals(bytes)) throw new Error(`Conflicting packaged skill file: ${relative}`);
  if (!hadFile) {
    let namespace = FILE_MAP_PATHS.get(files);
    if (!namespace) {
      namespace = createSourcePathNamespace();
      FILE_MAP_PATHS.set(files, namespace);
    }
    namespace.add(relative, "file");
  }
  const copied = Buffer.from(bytes);
  files.set(relative, copied);
  const totalBytes = (FILE_MAP_BYTES.get(files) ?? 0) + (existing ? 0 : copied.byteLength);
  FILE_MAP_BYTES.set(files, totalBytes);
  if (files.size > MAX_SKILL_FILES || totalBytes > MAX_SKILL_BYTES) {
    throw new Error("Packaged skill exceeds file count or size limits.");
  }
}

function selectedSkillFiles(cached: CachedSource, entry: ValidatedEntry): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const skillDirectory = path.posix.dirname(entry.path);
  const selectedSourceFiles = new Set<string>([entry.path]);
  if (entry.supportPaths === undefined) {
    for (const file of listCachedFiles(cached, skillDirectory)) selectedSourceFiles.add(file);
  } else {
    for (const supportPath of entry.supportPaths) {
      const sourcePath = skillDirectory === "." ? supportPath : `${skillDirectory}/${supportPath}`;
      const target = safeCachedPath(cached, sourcePath);
      if (!target) throw new Error(`Selected support path does not exist: ${sourcePath}`);
      for (const file of listCachedFiles(cached, sourcePath)) selectedSourceFiles.add(file);
    }
  }
  const sourceDirectory = skillDirectory === "." ? "" : `${skillDirectory}/`;
  for (const sourcePath of [...selectedSourceFiles].sort(lexicalCompare)) {
    const relative = sourcePath.startsWith(sourceDirectory) ? sourcePath.slice(sourceDirectory.length) : sourcePath;
    addFile(files, relative, verifyCachedFile(cached, sourcePath));
  }
  return files;
}

function protectedSourceSelection(
  source: ValidatedSkillSource,
  entries: readonly ValidatedEntry[],
): PinnedSourceSelection {
  const files = new Set<string>();
  const trees = new Set<string>();
  if (source.licensePath !== undefined) files.add(source.licensePath);
  for (const entry of entries) {
    files.add(entry.path);
    const skillDirectory = path.posix.dirname(entry.path);
    if (entry.supportPaths === undefined) {
      if (skillDirectory !== ".") trees.add(skillDirectory);
      continue;
    }
    for (const supportPath of entry.supportPaths) {
      trees.add(skillDirectory === "." ? supportPath : `${skillDirectory}/${supportPath}`);
    }
  }
  return { files: [...files], trees: [...trees] };
}

function readonlyMap(files: Map<string, Buffer>): ReadonlyMap<string, Buffer> {
  const entries = [...files.entries()];
  const lookup = new Map(entries);
  const view = {
    get size() { return lookup.size; },
    get: (key) => lookup.get(key),
    has: (key) => lookup.has(key),
    entries: () => lookup.entries(),
    keys: () => lookup.keys(),
    values: () => lookup.values(),
    forEach: (callback, thisArg) => lookup.forEach((value, key) => callback.call(thisArg, value, key, view)),
    [Symbol.iterator]: () => lookup[Symbol.iterator](),
  } as ReadonlyMap<string, Buffer>;
  Object.defineProperty(view, Symbol.toStringTag, { value: "ReadonlyMap" });
  return Object.freeze(view);
}

function provenanceFile(
  source: ValidatedSkillSource,
  entry: ValidatedEntry,
  cached: CachedSource,
  files: Map<string, Buffer>,
  licenseEvidence: SherpaSkillLicenseEvidence,
): Buffer {
  const fileHashes = Object.fromEntries([...files.entries()].sort(([left], [right]) => lexicalCompare(left, right))
    .map(([relative, bytes]) => [relative, hash(bytes)]));
  return Buffer.from(`${stableJson({
    repository: cached.marker.repository,
    commit: cached.marker.commit,
    sourcePath: entry.path,
    archiveSha256: cached.marker.archiveSha256,
    licenseEvidence,
    fileHashes,
  })}\n`, "utf8");
}

function sourceFailure(
  source: ValidatedSkillSource,
  entries: readonly ValidatedEntry[],
  error: unknown,
): SherpaSkillDiagnostic[] {
  const message = error instanceof Error ? error.message : "Pinned skill source is unavailable.";
  return entries.map((entry) => ({
    namespace: source.namespace,
    repository: source.repository,
    commit: source.commit,
    code: "source-unavailable",
    message,
    skillId: entry.targetId,
    sourcePath: entry.path,
  }));
}

export async function resolveSherpaSkillSources(
  sources: readonly SherpaSkillSource[],
  options: SherpaSkillSourceOptions = {},
): Promise<SherpaSkillResolution> {
  const validated = validateSkillSources(sources);
  let selectedIds: Set<string> | undefined;
  if (options.skillIds !== undefined) {
    if (!Array.isArray(options.skillIds) || options.skillIds.some((id) => typeof id !== "string")) {
      throw new TypeError("skillIds must be an array of declared target skill IDs.");
    }
    if (new Set(options.skillIds).size !== options.skillIds.length) throw new TypeError("skillIds must not contain duplicates.");
    selectedIds = new Set(options.skillIds);
    const knownIds = new Set(validated.flatMap((source) => source.skills.map((entry) => entry.targetId)));
    const unknown = options.skillIds.find((id) => !knownIds.has(id));
    if (unknown) throw new TypeError(`Unknown Sherpa skill ID '${unknown}'.`);
  }
  const selected = validated.map((source) => ({
    source,
    entries: source.skills.filter((entry) => selectedIds === undefined || selectedIds.has(entry.targetId)),
  })).filter(({ entries }) => entries.length > 0);
  if (selected.length === 0) return { skills: [], sources: [], diagnostics: [] };

  const packagedSkills: PackagedSkill[] = [];
  const sourceInfos: SherpaSkillSourceInfo[] = [];
  const diagnostics: SherpaSkillDiagnostic[] = [];
  for (const { source, entries } of selected) {
    let cached: CachedSource;
    try {
      cached = await resolvePinnedSource(source, options, protectedSourceSelection(source, entries));
    } catch (error) {
      diagnostics.push(...sourceFailure(source, entries, error));
      continue;
    }
    const sourceSkillInfos: SherpaSkillSourceInfo["skills"][number][] = [];
    for (const entry of entries) {
      let sourceSkillPath: string | undefined;
      try {
        sourceSkillPath = safeCachedPath(cached, entry.path);
      } catch (error) {
        diagnostics.push({
          namespace: source.namespace,
          repository: cached.marker.repository,
          commit: cached.marker.commit,
          code: "invalid-skill",
          message: error instanceof Error ? error.message : "Skill path is invalid.",
          skillId: entry.targetId,
          sourcePath: entry.path,
        });
        continue;
      }
      if (!sourceSkillPath) {
        diagnostics.push({
          namespace: source.namespace,
          repository: cached.marker.repository,
          commit: cached.marker.commit,
          code: "missing-skill",
          message: `Selected skill does not exist: ${entry.path}`,
          skillId: entry.targetId,
          sourcePath: entry.path,
        });
        continue;
      }
      let fileMap: Map<string, Buffer>;
      let parsed: ReturnType<typeof parseSkillDocument>;
      try {
        const skillBytes = verifyCachedFile(cached, entry.path);
        if (!sourceSkillPath || !path.isAbsolute(sourceSkillPath)) throw new Error(`Invalid selected skill path: ${entry.path}`);
        fileMap = selectedSkillFiles(cached, entry);
        parsed = parseSkillDocument(skillBytes.toString("utf8"), entry.targetId, entry.path);
      } catch (error) {
        diagnostics.push({
          namespace: source.namespace,
          repository: cached.marker.repository,
          commit: cached.marker.commit,
          code: "invalid-skill",
          message: error instanceof Error ? error.message : "Skill document is invalid.",
          skillId: entry.targetId,
          sourcePath: entry.path,
        });
        continue;
      }

      let licenseEvidence: SherpaSkillLicenseEvidence;
      let licenseBytes: Buffer | undefined;
      if (source.licensePath !== undefined) {
        try {
          licenseBytes = verifyCachedFile(cached, source.licensePath);
          licenseEvidence = { kind: "file", path: source.licensePath, sha256: hash(licenseBytes) };
        } catch (error) {
          diagnostics.push({
            namespace: source.namespace,
            repository: cached.marker.repository,
            commit: cached.marker.commit,
            code: "invalid-license",
            message: error instanceof Error ? error.message : "Pinned license file is invalid.",
            skillId: entry.targetId,
            sourcePath: entry.path,
          });
          continue;
        }
      } else {
        if (parsed.license !== source.license) {
          diagnostics.push({
            namespace: source.namespace,
            repository: cached.marker.repository,
            commit: cached.marker.commit,
            code: "invalid-license",
            message: `Skill frontmatter license '${parsed.license ?? "<missing>"}' does not match declared license '${source.license}'.`,
            skillId: entry.targetId,
            sourcePath: entry.path,
          });
          continue;
        }
        licenseEvidence = { kind: "declared", identifier: source.license! };
      }

      if (licenseBytes) {
        try {
          addFile(fileMap, "SHERPA-LICENSE.txt", licenseBytes, true);
        } catch (error) {
          diagnostics.push({
            namespace: source.namespace,
            repository: cached.marker.repository,
            commit: cached.marker.commit,
            code: "invalid-license",
            message: error instanceof Error ? error.message : "Pinned license file is invalid.",
            skillId: entry.targetId,
            sourcePath: entry.path,
          });
          continue;
        }
      }
      const provenance = provenanceFile(source, entry, cached, fileMap, licenseEvidence);
      try {
        addFile(fileMap, "SHERPA-SOURCE.json", provenance, true);
      } catch (error) {
        diagnostics.push({
          namespace: source.namespace,
          repository: cached.marker.repository,
          commit: cached.marker.commit,
          code: "invalid-skill",
          message: error instanceof Error ? error.message : "Skill file map is invalid.",
          skillId: entry.targetId,
          sourcePath: entry.path,
        });
        continue;
      }
      packagedSkills.push({
        id: entry.targetId,
        name: parsed.name,
        description: parsed.description,
        ...(parsed.autoinvoke === undefined ? {} : { autoinvoke: parsed.autoinvoke }),
        path: `${cached.marker.repository}@${cached.marker.commit}/${entry.path}`,
        content: parsed.content,
        files: readonlyMap(fileMap),
      });
      sourceSkillInfos.push({ id: entry.targetId, sourcePath: entry.path, licenseEvidence });
    }
    sourceInfos.push({
      namespace: source.namespace,
      repository: cached.marker.repository,
      commit: cached.marker.commit,
      archiveSha256: cached.marker.archiveSha256,
      skills: sourceSkillInfos,
    });
  }
  return {
    skills: packagedSkills.sort((left, right) => lexicalCompare(left.id, right.id)),
    sources: sourceInfos,
    diagnostics,
  };
}
