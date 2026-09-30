import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import * as tar from "tar";
import { parse as parseYaml } from "yaml";
import type { SherpaAgentSource } from "./agent-source-config.ts";
import {
  atomicWrite,
  ensureDirectory,
  hash,
  inspectPath,
  isRecord,
  lexicalCompare,
  readTextFile,
  SHA256,
  stableJson,
} from "./agent-files.ts";

const CACHE_STATE_FILE = "state.json";
const CACHE_MARKER_FILE = ".sherpa-source-cache.json";
const NAMESPACE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const FULL_COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu;
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 20_000;
const MAX_PROMPT_BYTES = 4 * 1024 * 1024;
const NETWORK_TIMEOUT_MS = 30_000;

export interface SherpaOmoAgent {
  readonly id: string;
  readonly description: string;
  readonly orchestratorPrompt: string;
  readonly prompt: string;
  readonly sourceNamespace: string;
  readonly sourceRepository: string;
  readonly sourceCommit: string;
  readonly sourcePath: string;
}

export interface SherpaAgentSourceOptions {
  readonly cacheDirectory?: string;
  readonly homeDirectory?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
}

export interface SherpaAgentSourceInfo {
  readonly namespace: string;
  readonly repository: string;
  readonly commit: string;
  readonly cacheHit: boolean;
  readonly archiveSha256: string;
  readonly licensePath: string;
  readonly licenseText: string;
}

export interface SherpaAgentDiagnostic {
  readonly namespace: string;
  readonly repository: string;
  readonly commit: string;
  readonly code: "source-unavailable" | "missing-directory" | "invalid-prompt";
  readonly message: string;
  readonly sourcePath?: string;
}

export interface SherpaAgentResolution {
  readonly agents: readonly SherpaOmoAgent[];
  readonly sources: readonly SherpaAgentSourceInfo[];
  readonly diagnostics: readonly SherpaAgentDiagnostic[];
}

interface ParsedRepository {
  readonly owner: string;
  readonly name: string;
  readonly canonical: string;
  readonly archiveUrl: (commit: string) => string;
}

interface ValidatedSource extends SherpaAgentSource {
  readonly repository: string;
  readonly commit: string;
  readonly owner: string;
  readonly repositoryName: string;
  readonly cacheKey: string;
}

interface CacheMarker {
  readonly version: 1;
  readonly repository: string;
  readonly commit: string;
  readonly archiveSha256: string;
  readonly treeSha256: string;
  readonly files: Record<string, string>;
}

interface CacheIndex {
  readonly version: 1;
  readonly sources: Record<string, Omit<CacheMarker, "version" | "files">>;
}

interface CachedSource {
  readonly root: string;
  readonly marker: CacheMarker;
  readonly cacheHit: boolean;
}

function parseRepository(repository: string): ParsedRepository {
  const trimmed = repository.trim();
  let owner: string;
  let name: string;
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(trimmed)) {
    [owner, name] = trimmed.split("/") as [string, string];
  } else {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw new Error(`Invalid GitHub repository descriptor: ${repository}`);
    }
    const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/u.exec(url.pathname);
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.search || url.hash ||
      url.username || url.password || !match) {
      throw new Error(`Only owner/repository and HTTPS github.com URLs are supported: ${repository}`);
    }
    owner = match[1]!;
    name = match[2]!;
  }
  const canonical = `${owner.toLowerCase()}/${name.toLowerCase()}`;
  return {
    owner,
    name,
    canonical,
    archiveUrl: (commit) => `https://codeload.github.com/${owner}/${name}/tar.gz/${commit}`,
  };
}

function validateDirectory(directory: string, source: string): string {
  const normalized = directory.replaceAll("\\", "/").replace(/\/+$/u, "");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized) ||
    normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`Unsafe selected source directory '${directory}' in ${source}.`);
  }
  return normalized;
}

function validateSource(source: SherpaAgentSource): ValidatedSource {
  if (!isRecord(source)) throw new Error("Agent source descriptor must be an object.");
  const repository = parseRepository(String(source.repository));
  const namespace = String(source.namespace).trim();
  if (!NAMESPACE.test(namespace)) throw new Error(`Invalid agent source namespace '${namespace}'.`);
  const commit = String(source.commit).toLowerCase();
  if (!FULL_COMMIT.test(commit)) {
    throw new Error(`Agent source '${namespace}' requires an immutable full commit SHA.`);
  }
  if (!Array.isArray(source.directories) || source.directories.length === 0) {
    throw new Error(`Agent source '${namespace}' requires one or more selected directories.`);
  }
  const directories = [...new Set(source.directories.map((directory) => {
    if (typeof directory !== "string") throw new Error(`Invalid selected directory in agent source '${namespace}'.`);
    return validateDirectory(directory, namespace);
  }))].sort(lexicalCompare);
  return {
    repository: repository.canonical,
    commit,
    directories,
    namespace,
    owner: repository.owner,
    repositoryName: repository.name,
    cacheKey: hash(`${repository.canonical}\0${commit}`),
  };
}

function defaultCacheDirectory(options: SherpaAgentSourceOptions): string {
  if (options.cacheDirectory?.trim()) return path.resolve(options.cacheDirectory.trim());
  const env = options.env ?? process.env;
  const home = path.resolve(options.homeDirectory ?? homedir());
  const configuredCache = env.OPENCODE_CACHE_DIR?.trim();
  if (configuredCache && path.isAbsolute(configuredCache)) {
    return path.join(path.resolve(configuredCache), ".sherpa", "agent-sources");
  }
  const xdgCache = env.XDG_CACHE_HOME?.trim();
  const cacheRoot = xdgCache && path.isAbsolute(xdgCache)
    ? path.join(path.resolve(xdgCache), "opencode")
    : path.join(home, ".cache", "opencode");
  return path.join(cacheRoot, ".sherpa", "agent-sources");
}

async function fetchArchive(url: string, fetchImpl: typeof fetch): Promise<{ bytes: Buffer; sha256: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Source archive download failed: HTTP ${response.status}`);
    const length = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(length) && length > MAX_ARCHIVE_BYTES) {
      throw new Error(`Source archive exceeds ${MAX_ARCHIVE_BYTES} byte limit.`);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;
          total += value.byteLength;
          if (total > MAX_ARCHIVE_BYTES) {
            await reader.cancel().catch(() => undefined);
            throw new Error(`Source archive exceeds ${MAX_ARCHIVE_BYTES} byte limit.`);
          }
          chunks.push(Buffer.from(value));
        }
      } finally {
        reader.releaseLock();
      }
    } else {
      const bytes = Buffer.from(await response.arrayBuffer());
      total = bytes.byteLength;
      if (total > MAX_ARCHIVE_BYTES) throw new Error(`Source archive exceeds ${MAX_ARCHIVE_BYTES} byte limit.`);
      chunks.push(bytes);
    }
    const bytes = Buffer.concat(chunks, total);
    return { bytes, sha256: hash(bytes) };
  } finally {
    clearTimeout(timeout);
  }
}

function inventoryDirectory(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  let totalBytes = 0;
  let count = 0;
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => lexicalCompare(a.name, b.name))) {
      const file = path.join(directory, entry.name);
      const relative = path.relative(root, file).split(path.sep).join("/");
      if (relative === CACHE_MARKER_FILE) continue;
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error(`Source archive contains symlink: ${relative}`);
      if (stat.isDirectory()) {
        visit(file);
        continue;
      }
      if (!stat.isFile()) throw new Error(`Unsupported source archive entry: ${relative}`);
      count++;
      totalBytes += stat.size;
      if (count > MAX_ARCHIVE_ENTRIES || totalBytes > MAX_EXTRACTED_BYTES) {
        throw new Error("Source archive exceeds extraction limits.");
      }
      files[relative] = hash(readFileSync(file));
    }
  };
  visit(root);
  return files;
}

function sourceLicense(root: string, marker: CacheMarker): { path: string; text: string } {
  const candidates = Object.keys(marker.files).sort(lexicalCompare);
  const licensePath = candidates.find((relative) => {
    const basename = path.posix.basename(relative).toLowerCase();
    return basename === "license" || basename.startsWith("license.") ||
      basename === "copying" || basename.startsWith("copying.");
  });
  return licensePath
    ? { path: licensePath, text: readFileSync(path.join(root, ...licensePath.split("/")), "utf8") }
    : { path: "", text: "" };
}

function treeHash(files: Record<string, string>): string {
  return hash(stableJson(files));
}

function validateCacheMarker(value: unknown, repository: string, commit: string): CacheMarker | undefined {
  if (!isRecord(value) || value.version !== 1 || value.repository !== repository || value.commit !== commit ||
    typeof value.archiveSha256 !== "string" || !SHA256.test(value.archiveSha256) ||
    typeof value.treeSha256 !== "string" || !SHA256.test(value.treeSha256) || !isRecord(value.files)) return undefined;
  const files: Record<string, string> = {};
  for (const [file, digest] of Object.entries(value.files)) {
    if (typeof digest !== "string" || !SHA256.test(digest) || validateDirectory(file, "cache manifest") !== file) return undefined;
    files[file] = digest;
  }
  return { version: 1, repository, commit, archiveSha256: value.archiveSha256, treeSha256: value.treeSha256, files };
}

function readCacheIndex(file: string): CacheIndex {
  const contents = readTextFile(file);
  if (contents === undefined) return { version: 1, sources: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error(`Agent source cache state is malformed: ${file}`);
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.sources)) {
    throw new Error(`Agent source cache state is malformed: ${file}`);
  }
  const sources: Record<string, Omit<CacheMarker, "version" | "files">> = {};
  for (const [key, value] of Object.entries(parsed.sources)) {
    if (!SHA256.test(key) || !isRecord(value) || typeof value.repository !== "string" ||
      typeof value.commit !== "string" || !FULL_COMMIT.test(value.commit) ||
      typeof value.archiveSha256 !== "string" || !SHA256.test(value.archiveSha256) ||
      typeof value.treeSha256 !== "string" || !SHA256.test(value.treeSha256)) {
      throw new Error(`Agent source cache state is malformed: ${file}`);
    }
    sources[key] = {
      repository: value.repository,
      commit: value.commit,
      archiveSha256: value.archiveSha256,
      treeSha256: value.treeSha256,
    };
  }
  return { version: 1, sources };
}

function writeCacheIndex(file: string, index: CacheIndex): void {
  atomicWrite(file, `${JSON.stringify(index, null, 2)}\n`);
}

function verifyCachedSource(root: string, source: ValidatedSource): CacheMarker | undefined {
  const stat = inspectPath(root);
  if (!stat) return undefined;
  if (!stat.isDirectory()) throw new Error(`Agent source cache path is not a directory: ${root}`);
  const markerPath = path.join(root, CACHE_MARKER_FILE);
  const markerContents = readTextFile(markerPath);
  if (markerContents === undefined) throw new Error(`Agent source cache is missing marker: ${root}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(markerContents);
  } catch {
    throw new Error(`Agent source cache marker is malformed: ${root}`);
  }
  const marker = validateCacheMarker(parsed, source.repository, source.commit);
  if (!marker) throw new Error(`Agent source cache identity mismatch: ${root}`);
  const actualFiles = inventoryDirectory(root);
  if (stableJson(actualFiles) !== stableJson(marker.files) || treeHash(actualFiles) !== marker.treeSha256) {
    throw new Error(`Agent source cache integrity check failed: ${root}`);
  }
  return marker;
}

function validateArchiveEntry(entryPath: string, entry: unknown, state: { count: number; bytes: number }): boolean {
  const normalized = entryPath.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized) ||
    normalized.split("/").some((segment) => segment === "..")) {
    throw new Error(`Unsafe source archive path: ${entryPath}`);
  }
  state.count++;
  if (state.count > MAX_ARCHIVE_ENTRIES) throw new Error("Source archive has too many entries.");
  if (isRecord(entry)) {
    const type = entry.type;
    if (typeof type === "string" && !["File", "OldFile", "ContiguousFile", "Directory"].includes(type)) {
      throw new Error(`Unsupported source archive entry type: ${type}`);
    }
    const size = Number(entry.size ?? 0);
    if (!Number.isFinite(size) || size < 0) throw new Error("Invalid source archive entry size.");
    state.bytes += size;
    if (state.bytes > MAX_EXTRACTED_BYTES) throw new Error("Source archive exceeds extraction size limit.");
  }
  return true;
}

async function installSourceArchive(
  source: ValidatedSource,
  cacheDirectory: string,
  fetchImpl: typeof fetch,
): Promise<CachedSource> {
  const finalRoot = path.join(cacheDirectory, source.cacheKey);
  const existing = verifyCachedSource(finalRoot, source);
  if (existing) return { root: finalRoot, marker: existing, cacheHit: true };

  const repository = parseRepository(source.repository);
  const downloaded = await fetchArchive(repository.archiveUrl(source.commit), fetchImpl);
  const temporaryRoot = mkdtempSync(path.join(cacheDirectory, `.extract-${source.cacheKey.slice(0, 12)}-`));
  const archivePath = path.join(temporaryRoot, "source.tgz");
  const extractedRoot = path.join(temporaryRoot, "source");
  mkdirSync(extractedRoot, { mode: 0o700 });
  try {
    writeFileSync(archivePath, downloaded.bytes, { mode: 0o600 });
    const limits = { count: 0, bytes: 0 };
    await tar.x({
      cwd: extractedRoot,
      file: archivePath,
      strip: 1,
      strict: true,
      preservePaths: false,
      maxDecompressionRatio: 100,
      filter: (entryPath, entry) => validateArchiveEntry(entryPath, entry, limits),
    });
    const files = inventoryDirectory(extractedRoot);
    const marker: CacheMarker = {
      version: 1,
      repository: source.repository,
      commit: source.commit,
      archiveSha256: downloaded.sha256,
      treeSha256: treeHash(files),
      files,
    };
    writeFileSync(path.join(extractedRoot, CACHE_MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });

    if (inspectPath(finalRoot)) {
      const raced = verifyCachedSource(finalRoot, source);
      if (!raced) throw new Error(`Agent source cache destination appeared during install: ${finalRoot}`);
      return { root: finalRoot, marker: raced, cacheHit: true };
    }
    renameSync(extractedRoot, finalRoot);
    return { root: finalRoot, marker, cacheHit: false };
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

async function ensureCachedSource(
  source: ValidatedSource,
  cacheDirectory: string,
  fetchImpl: typeof fetch,
): Promise<CachedSource> {
  ensureDirectory(cacheDirectory);
  const statePath = path.join(cacheDirectory, CACHE_STATE_FILE);
  const index = readCacheIndex(statePath);
  const cached = await installSourceArchive(source, cacheDirectory, fetchImpl);
  const previous = index.sources[source.cacheKey];
  if (previous && (previous.repository !== cached.marker.repository || previous.commit !== cached.marker.commit ||
    previous.archiveSha256 !== cached.marker.archiveSha256 || previous.treeSha256 !== cached.marker.treeSha256)) {
    throw new Error(`Agent source cache state does not match immutable cache: ${source.cacheKey}`);
  }
  if (!previous) {
    writeCacheIndex(statePath, {
      version: 1,
      sources: {
        ...index.sources,
        [source.cacheKey]: {
          repository: cached.marker.repository,
          commit: cached.marker.commit,
          archiveSha256: cached.marker.archiveSha256,
          treeSha256: cached.marker.treeSha256,
        },
      },
    });
  }
  return cached;
}

function safeSelectedPath(root: string, relative: string): string | undefined {
  let current = root;
  const segments = relative.split("/");
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const stat = inspectPath(current);
    if (!stat) return undefined;
    const final = index === segments.length - 1;
    if (!final && !stat.isDirectory()) throw new Error(`Selected agent source path is not a directory: ${relative}`);
    if (final && !stat.isDirectory() && !stat.isFile()) {
      throw new Error(`Selected agent source path is not a regular file or directory: ${relative}`);
    }
  }
  return current;
}

function markdownFiles(root: string, selected: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => lexicalCompare(a.name, b.name))) {
      const absolute = path.join(directory, entry.name);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`Cached agent source contains symlink: ${absolute}`);
      if (stat.isDirectory()) visit(absolute);
      else if (stat.isFile() && path.extname(entry.name).toLowerCase() === ".md" &&
        entry.name.toLowerCase() !== "readme.md") {
        files.push(path.relative(root, absolute).split(path.sep).join("/"));
      }
    }
  };
  const stat = inspectPath(selected);
  if (stat?.isFile()) {
    if (path.extname(selected).toLowerCase() === ".md" && path.basename(selected).toLowerCase() !== "readme.md") {
      files.push(path.relative(root, selected).split(path.sep).join("/"));
    }
    return files;
  }
  visit(selected);
  return files;
}

function slugPath(relativePath: string): string {
  return relativePath.replace(/\.md$/iu, "")
    .split("/")
    .map((segment) => segment.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, ""))
    .filter(Boolean)
    .join("-");
}

function inferredDescription(id: string, prompt: string): string {
  const lines = prompt.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const heading = lines.find((line) => /^#{1,6}\s+/u.test(line));
  const candidate = (heading ?? lines[0] ?? id).replace(/^#{1,6}\s+/u, "").replace(/\s+/gu, " ").trim();
  const sentence = candidate.split(/(?<=[.!?])\s/u, 1)[0] ?? candidate;
  return sentence.length > 200 ? `${sentence.slice(0, 197).trimEnd()}...` : sentence;
}

function parseSourcePrompt(
  file: string,
  id: string,
  source: ValidatedSource,
  relativePath: string,
): SherpaOmoAgent {
  const bytes = readFileSync(file);
  if (bytes.byteLength > MAX_PROMPT_BYTES) throw new Error(`Agent prompt exceeds ${MAX_PROMPT_BYTES} byte limit.`);
  const raw = bytes.toString("utf8").replace(/^\uFEFF/u, "");
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u.exec(raw);
  let metadata: Record<string, unknown> = {};
  let prompt = raw.trim();
  if (match) {
    let parsed: unknown;
    try {
      parsed = parseYaml(match[1] ?? "");
    } catch {
      throw new Error("Agent prompt frontmatter is malformed YAML.");
    }
    if (!isRecord(parsed)) throw new Error("Agent prompt frontmatter must be a YAML object.");
    metadata = parsed;
    prompt = raw.slice(match[0].length).trim();
  } else if (/^---[ \t]*(?:\r?\n|$)/u.test(raw)) {
    throw new Error("Agent prompt frontmatter has no closing delimiter.");
  }
  if (!prompt) throw new Error("Agent prompt body is empty.");

  const rawDescription = metadata.description;
  if (rawDescription !== undefined && (typeof rawDescription !== "string" || rawDescription.trim() === "")) {
    throw new Error("Agent prompt description must be a non-empty string.");
  }
  const description = typeof rawDescription === "string" ? rawDescription.trim() : inferredDescription(id, prompt);
  const rawOrchestratorPrompt = metadata.orchestratorPrompt;
  if (rawOrchestratorPrompt !== undefined &&
    (typeof rawOrchestratorPrompt !== "string" || rawOrchestratorPrompt.trim() === "")) {
    throw new Error("Agent prompt orchestratorPrompt must be a non-empty string.");
  }
  const orchestratorPrompt = typeof rawOrchestratorPrompt === "string"
    ? rawOrchestratorPrompt.trim()
    : `Delegate to @${id} for ${description}`;

  return {
    id,
    description,
    orchestratorPrompt,
    prompt,
    sourceNamespace: source.namespace,
    sourceRepository: source.repository,
    sourceCommit: source.commit,
    sourcePath: relativePath,
  };
}

function collectAgents(source: ValidatedSource, cached: CachedSource): {
  agents: SherpaOmoAgent[];
  diagnostics: SherpaAgentDiagnostic[];
} {
  const agents: SherpaOmoAgent[] = [];
  const diagnostics: SherpaAgentDiagnostic[] = [];
  const visited = new Set<string>();
  for (const directory of source.directories) {
    const selected = safeSelectedPath(cached.root, directory);
    if (!selected) {
      diagnostics.push({
        namespace: source.namespace,
        repository: source.repository,
        commit: source.commit,
        code: "missing-directory",
        message: `Selected source path does not exist: ${directory}`,
      });
      continue;
    }
    for (const relativePath of markdownFiles(cached.root, selected)) {
      if (visited.has(relativePath)) continue;
      visited.add(relativePath);
      const slug = slugPath(relativePath);
      if (!slug) {
        diagnostics.push({
          namespace: source.namespace,
          repository: source.repository,
          commit: source.commit,
          code: "invalid-prompt",
          sourcePath: relativePath,
          message: "Agent prompt path does not produce a valid ID.",
        });
        continue;
      }
      const id = `sherpa-${source.namespace}-${slug}`;
      const file = path.join(cached.root, ...relativePath.split("/"));
      try {
        agents.push(parseSourcePrompt(file, id, source, relativePath));
      } catch (error) {
        diagnostics.push({
          namespace: source.namespace,
          repository: source.repository,
          commit: source.commit,
          code: "invalid-prompt",
          sourcePath: relativePath,
          message: error instanceof Error ? error.message : "Agent prompt is invalid.",
        });
      }
    }
  }
  return { agents, diagnostics };
}

export function defaultSherpaAgentCacheDirectory(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): string {
  return defaultCacheDirectory({ env, homeDirectory });
}

export async function resolveSherpaAgentSources(
  sources: readonly SherpaAgentSource[],
  options: SherpaAgentSourceOptions = {},
): Promise<SherpaAgentResolution> {
  if (!Array.isArray(sources)) throw new Error("Agent sources must be provided as an array.");
  if (sources.length === 0) return { agents: [], sources: [], diagnostics: [] };
  const validated = sources.map(validateSource).sort((left, right) => lexicalCompare(left.namespace, right.namespace) ||
    lexicalCompare(left.repository, right.repository) || lexicalCompare(left.commit, right.commit));
  const cacheDirectory = defaultCacheDirectory(options);
  ensureDirectory(cacheDirectory);
  const fetchImpl = options.fetchImpl ?? fetch;
  const agents: SherpaOmoAgent[] = [];
  const sourceInfo: SherpaAgentSourceInfo[] = [];
  const diagnostics: SherpaAgentDiagnostic[] = [];

  for (const source of validated) {
    try {
      const cached = await ensureCachedSource(source, cacheDirectory, fetchImpl);
      const result = collectAgents(source, cached);
      const license = sourceLicense(cached.root, cached.marker);
      agents.push(...result.agents);
      diagnostics.push(...result.diagnostics);
      sourceInfo.push({
        namespace: source.namespace,
        repository: source.repository,
        commit: source.commit,
        cacheHit: cached.cacheHit,
        archiveSha256: cached.marker.archiveSha256,
        licensePath: license.path,
        licenseText: license.text,
      });
    } catch (error) {
      diagnostics.push({
        namespace: source.namespace,
        repository: source.repository,
        commit: source.commit,
        code: "source-unavailable",
        message: error instanceof Error ? error.message : "Pinned agent source is unavailable.",
      });
    }
  }

  const byId = new Map<string, SherpaOmoAgent>();
  for (const agent of agents) {
    const previous = byId.get(agent.id);
    if (previous) {
      throw new Error(
        `Ambiguous Sherpa agent ID '${agent.id}' from ${previous.sourceRepository}/${previous.sourcePath} and ${agent.sourceRepository}/${agent.sourcePath}.`,
      );
    }
    byId.set(agent.id, agent);
  }
  return {
    agents: [...byId.values()].sort((left, right) => lexicalCompare(left.id, right.id)),
    sources: sourceInfo,
    diagnostics,
  };
}
