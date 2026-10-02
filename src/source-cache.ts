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
const FULL_COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu;
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 20_000;
const MAX_SKIPPED_SYMLINKS = 1_024;
const MAX_SKIPPED_SYMLINK_BYTES = 256 * 1024;
const NETWORK_TIMEOUT_MS = 30_000;

export interface PinnedSource {
  readonly repository: string;
  readonly commit: string;
}

export interface SourceCacheOptions {
  readonly cacheDirectory?: string;
  readonly homeDirectory?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
}

export interface PinnedSourceSelection {
  readonly files: readonly string[];
  readonly trees: readonly string[];
}

export interface CacheMarker {
  readonly version: 1;
  readonly repository: string;
  readonly commit: string;
  readonly archiveSha256: string;
  readonly treeSha256: string;
  readonly files: Record<string, string>;
  readonly skippedSymlinks: Record<string, string>;
}

export interface CachedSource {
  readonly root: string;
  readonly marker: CacheMarker;
  readonly cacheHit: boolean;
}

interface ParsedRepository {
  readonly owner: string;
  readonly name: string;
  readonly canonical: string;
  readonly archiveUrl: (commit: string) => string;
}

interface ValidatedSource extends PinnedSource {
  readonly repository: string;
  readonly commit: string;
  readonly cacheKey: string;
}

interface CacheIndex {
  readonly version: 1;
  readonly sources: Record<string, Omit<CacheMarker, "version" | "files">>;
}

interface ValidatedSelection {
  readonly files: readonly string[];
  readonly trees: readonly string[];
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

function validateSource(source: PinnedSource): ValidatedSource {
  if (!isRecord(source) || typeof source.repository !== "string" || typeof source.commit !== "string") {
    throw new Error("Pinned source descriptor must include repository and commit strings.");
  }
  const repository = parseRepository(source.repository);
  const commit = source.commit.toLowerCase();
  if (!FULL_COMMIT.test(commit)) throw new Error("Pinned source requires an immutable full commit SHA.");
  return {
    repository: repository.canonical,
    commit,
    cacheKey: hash(`${repository.canonical}\0${commit}`),
  };
}

export function normalizePinnedSource(source: PinnedSource): PinnedSource {
  const validated = validateSource(source);
  return { repository: validated.repository, commit: validated.commit };
}

function defaultCacheDirectory(options: SourceCacheOptions): string {
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

export function defaultSherpaSourceCacheDirectory(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): string {
  return defaultCacheDirectory({ env, homeDirectory });
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

function inventoryDirectory(root: string, directories?: string[]): Record<string, string> {
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
        directories?.push(relative);
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
  validateFilePathNamespace(Object.keys(files));
  return files;
}

function treeHash(files: Record<string, string>): string {
  return hash(stableJson(files));
}

function validateRelativeFile(file: string): boolean {
  const normalized = file.replaceAll("\\", "/").replace(/\/+$/u, "");
  return normalized === file && Boolean(normalized) && !normalized.startsWith("/") && !/^[A-Za-z]:/u.test(normalized) &&
    normalized.split("/").every((segment) => segment && segment !== "." && segment !== "..");
}

interface PathNamespaceEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
}

export type SourcePathKind = PathNamespaceEntry["kind"];

export interface SourcePathNamespace {
  add(relativePath: string, kind: SourcePathKind): void;
}

function registerPathNamespaceEntry(
  namespace: Map<string, PathNamespaceEntry>,
  relativePath: string,
  kind: SourcePathKind,
): void {
  const segments = relativePath.split("/");
  let parent = "";
  for (const segment of segments.slice(0, -1)) {
    parent = parent ? `${parent}/${segment}` : segment;
    const key = parent.toLowerCase();
    const existing = namespace.get(key);
    if (existing && existing.path !== parent) {
      throw new Error(`Case-insensitive source path collision: ${relativePath}`);
    }
    if (existing && existing.kind !== "directory") {
      throw new Error(`Source file conflicts with directory path: ${relativePath}`);
    }
    if (!existing) namespace.set(key, { path: parent, kind: "directory" });
  }

  const key = relativePath.toLowerCase();
  const existing = namespace.get(key);
  if (existing && existing.path !== relativePath) {
    throw new Error(`Case-insensitive source path collision: ${relativePath}`);
  }
  if (existing) {
    if (kind !== "directory" || existing.kind !== "directory") {
      throw new Error(`Duplicate or conflicting source path: ${relativePath}`);
    }
    return;
  }
  namespace.set(key, { path: relativePath, kind });
}

export function createSourcePathNamespace(): SourcePathNamespace {
  const namespace = new Map<string, PathNamespaceEntry>();
  return Object.freeze({
    add(relativePath: string, kind: SourcePathKind): void {
      if (!validateRelativeFile(relativePath)) throw new Error(`Unsafe source path: ${relativePath}`);
      registerPathNamespaceEntry(namespace, relativePath, kind);
    },
  });
}

function validateFilePathNamespace(files: Iterable<string>): void {
  const namespace = createSourcePathNamespace();
  for (const file of files) namespace.add(file, "file");
}

function validateSymlinkTarget(target: unknown): target is string {
  return typeof target === "string" && Boolean(target) && !target.startsWith("/") &&
    !/^[A-Za-z]:/u.test(target) && !target.includes("\\") && !target.includes("\0") &&
    target.split("/").every((segment) => segment && segment !== "." && segment !== "..");
}

function validateSkippedSymlinks(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries: [string, string][] = [];
  let metadataBytes = 0;
  for (const [relativePath, target] of Object.entries(value)) {
    if (!validateRelativeFile(relativePath) || relativePath.toLowerCase() === CACHE_MARKER_FILE.toLowerCase() ||
      !validateSymlinkTarget(target)) {
      return undefined;
    }
    entries.push([relativePath, target]);
    metadataBytes += Buffer.byteLength(relativePath) + Buffer.byteLength(target);
    if (entries.length > MAX_SKIPPED_SYMLINKS || metadataBytes > MAX_SKIPPED_SYMLINK_BYTES) return undefined;
  }
  try {
    validateFilePathNamespace(entries.map(([relativePath]) => relativePath));
  } catch {
    return undefined;
  }
  return Object.fromEntries(entries);
}

function validateSelection(selection: PinnedSourceSelection | undefined): ValidatedSelection | undefined {
  if (selection === undefined) return undefined;
  if (!isRecord(selection) || !Array.isArray(selection.files) || !Array.isArray(selection.trees)) {
    throw new TypeError("Pinned source selection must include files and trees arrays.");
  }
  const validatePaths = (values: unknown[]): string[] => values.map((value) => {
    if (typeof value !== "string" || !validateRelativeFile(value)) {
      throw new TypeError(`Unsafe pinned source selection path: ${String(value)}`);
    }
    return value.toLowerCase();
  });
  return { files: validatePaths(selection.files), trees: validatePaths(selection.trees) };
}

function pathContains(parent: string, child: string): boolean {
  return parent === child || child.startsWith(`${parent}/`);
}

function assertOmittedSymlinksAreUnselected(
  skippedSymlinks: Record<string, string>,
  selection: ValidatedSelection | undefined,
): void {
  for (const relativePath of Object.keys(skippedSymlinks)) {
    const candidate = relativePath.toLowerCase();
    const intersects = selection !== undefined && (
      selection.files.some((selectedFile) => pathContains(candidate, selectedFile)) ||
      selection.trees.some((tree) => pathContains(candidate, tree) || pathContains(tree, candidate))
    );
    if (!intersects) {
      if (selection === undefined) throw new Error(`Source archive contains symlink: ${relativePath}`);
      continue;
    }
    throw new Error(`Source archive symlink affects selected skill path: ${relativePath}`);
  }
}

function validateArchivePathNamespace(
  entryPath: string,
  entryType: string,
  namespace: SourcePathNamespace,
): void {
  const segments = archivePathSegments(entryPath, entryType).slice(1);
  if (segments.length === 0) {
    if (entryType === "Directory") return;
    throw new Error(`Unsafe source archive path after stripping repository root: ${entryPath}`);
  }
  const relativePath = segments.join("/");
  namespace.add(relativePath, entryType === "Directory" ? "directory" : "file");
}

function archivePathSegments(entryPath: string, entryType: string): string[] {
  if (!entryPath || entryPath.startsWith("/") || /^[A-Za-z]:/u.test(entryPath) ||
    entryPath.includes("\\") || entryPath.includes("\0")) {
    throw new Error(`Unsafe source archive path: ${entryPath}`);
  }
  const segments = entryPath.split("/");
  if (entryType === "Directory" && segments.at(-1) === "") segments.pop();
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`Unsafe source archive path: ${entryPath}`);
  }
  return segments;
}

function validateCacheMarker(value: unknown, repository: string, commit: string): CacheMarker | undefined {
  if (!isRecord(value) || value.version !== 1 || value.repository !== repository || value.commit !== commit ||
    typeof value.archiveSha256 !== "string" || !SHA256.test(value.archiveSha256) ||
    typeof value.treeSha256 !== "string" || !SHA256.test(value.treeSha256) || !isRecord(value.files)) return undefined;
  const files: Record<string, string> = {};
  for (const [file, digest] of Object.entries(value.files)) {
    if (typeof digest !== "string" || !SHA256.test(digest) || !validateRelativeFile(file)) return undefined;
    files[file] = digest;
  }
  const skippedSymlinks = Object.hasOwn(value, "skippedSymlinks")
    ? validateSkippedSymlinks(value.skippedSymlinks)
    : {};
  if (!skippedSymlinks) return undefined;
  try {
    validateFilePathNamespace([...Object.keys(files), ...Object.keys(skippedSymlinks)]);
  } catch {
    return undefined;
  }
  return {
    version: 1,
    repository,
    commit,
    archiveSha256: value.archiveSha256,
    treeSha256: value.treeSha256,
    files,
    skippedSymlinks,
  };
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
    const skippedSymlinks = Object.hasOwn(value, "skippedSymlinks")
      ? validateSkippedSymlinks(value.skippedSymlinks)
      : {};
    if (!skippedSymlinks) throw new Error(`Agent source cache state is malformed: ${file}`);
    sources[key] = {
      repository: value.repository,
      commit: value.commit,
      archiveSha256: value.archiveSha256,
      treeSha256: value.treeSha256,
      skippedSymlinks,
    };
  }
  return { version: 1, sources };
}

function writeCacheIndex(file: string, index: CacheIndex): void {
  atomicWrite(file, `${JSON.stringify(index, null, 2)}\n`);
}

function verifyCachedSource(
  root: string,
  source: ValidatedSource,
  selection: ValidatedSelection | undefined,
): CacheMarker | undefined {
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
  assertOmittedSymlinksAreUnselected(marker.skippedSymlinks, selection);
  const physicalDirectories: string[] = [];
  const actualFiles = inventoryDirectory(root, physicalDirectories);
  for (const relativePath of Object.keys(marker.skippedSymlinks)) {
    if (inspectPath(path.join(root, ...relativePath.split("/")))) {
      throw new Error(`Agent source cache integrity check failed: omitted symlink path exists: ${relativePath}`);
    }
  }
  try {
    const namespace = createSourcePathNamespace();
    for (const file of Object.keys(actualFiles)) namespace.add(file, "file");
    for (const directory of physicalDirectories) namespace.add(directory, "directory");
    for (const omittedPath of Object.keys(marker.skippedSymlinks)) namespace.add(omittedPath, "file");
  } catch {
    throw new Error(`Agent source cache integrity check failed: ${root}`);
  }
  if (stableJson(actualFiles) !== stableJson(marker.files) || treeHash(actualFiles) !== marker.treeSha256) {
    throw new Error(`Agent source cache integrity check failed: ${root}`);
  }
  return marker;
}

function validateArchiveEntry(entryPath: string, entry: unknown, state: { count: number; bytes: number }): boolean {
  if (!isRecord(entry) || typeof entry.type !== "string") {
    throw new Error("Unsupported source archive entry type.");
  }
  const type = entry.type;
  archivePathSegments(entryPath, type);
  state.count++;
  if (state.count > MAX_ARCHIVE_ENTRIES) throw new Error("Source archive has too many entries.");
  if (!["File", "OldFile", "ContiguousFile", "Directory", "SymbolicLink"].includes(type)) {
    throw new Error(`Unsupported source archive entry type: ${type}`);
  }
  const size = Number(entry.size ?? 0);
  if (!Number.isFinite(size) || size < 0) throw new Error("Invalid source archive entry size.");
  state.bytes += size;
  if (state.bytes > MAX_EXTRACTED_BYTES) throw new Error("Source archive exceeds extraction size limit.");
  return true;
}

async function installSourceArchive(
  source: ValidatedSource,
  cacheDirectory: string,
  fetchImpl: typeof fetch,
  selection: ValidatedSelection | undefined,
): Promise<CachedSource> {
  const finalRoot = path.join(cacheDirectory, source.cacheKey);
  const existing = verifyCachedSource(finalRoot, source, selection);
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
    const skippedSymlinks: Record<string, string> = {};
    let skippedSymlinkBytes = 0;
    const archivePaths = createSourcePathNamespace();
    let archiveValidationError: Error | undefined;
    await tar.x({
      cwd: extractedRoot,
      file: archivePath,
      strip: 1,
      strict: true,
      preservePaths: false,
       maxDecompressionRatio: 100,
       filter: (entryPath, entry) => {
         if (archiveValidationError) return false;
         try {
           if (!validateArchiveEntry(entryPath, entry, limits)) return false;
           if (!isRecord(entry) || typeof entry.type !== "string") {
             throw new Error("Unsupported source archive entry type.");
           }
           const metadata = entry as Record<string, unknown> & { type: string; linkpath?: unknown };
           validateArchivePathNamespace(entryPath, metadata.type, archivePaths);
           if (metadata.type === "SymbolicLink") {
             const relativePath = archivePathSegments(entryPath, metadata.type).slice(1).join("/");
             if (!validateSymlinkTarget(metadata.linkpath)) {
               throw new Error(`Unsafe source archive symlink target: ${relativePath}`);
             }
             if (relativePath.toLowerCase() === CACHE_MARKER_FILE.toLowerCase()) {
               throw new Error(`Source archive symlink conflicts with cache marker: ${relativePath}`);
             }
             assertOmittedSymlinksAreUnselected({ [relativePath]: metadata.linkpath }, selection);
             Object.defineProperty(skippedSymlinks, relativePath, {
               value: metadata.linkpath,
               enumerable: true,
               configurable: true,
               writable: true,
             });
             skippedSymlinkBytes += Buffer.byteLength(relativePath) + Buffer.byteLength(metadata.linkpath);
             if (Object.keys(skippedSymlinks).length > MAX_SKIPPED_SYMLINKS ||
               skippedSymlinkBytes > MAX_SKIPPED_SYMLINK_BYTES) {
               throw new Error("Source archive exceeds skipped symlink limits.");
             }
             return false;
           }
           return true;
         } catch (error) {
           archiveValidationError = error instanceof Error ? error : new Error("Source archive is invalid.");
           return false;
         }
       },
    });
    if (archiveValidationError) throw archiveValidationError;
    for (const relativePath of Object.keys(skippedSymlinks)) {
      if (inspectPath(path.join(extractedRoot, ...relativePath.split("/")))) {
        throw new Error(`Source archive omitted symlink path was materialized: ${relativePath}`);
      }
    }
    const files = inventoryDirectory(extractedRoot);
    validateFilePathNamespace([...Object.keys(files), ...Object.keys(skippedSymlinks)]);
    const marker: CacheMarker = {
      version: 1,
      repository: source.repository,
      commit: source.commit,
      archiveSha256: downloaded.sha256,
      treeSha256: treeHash(files),
      files,
      skippedSymlinks,
    };
    writeFileSync(path.join(extractedRoot, CACHE_MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });

    if (inspectPath(finalRoot)) {
      const raced = verifyCachedSource(finalRoot, source, selection);
      if (!raced) throw new Error(`Agent source cache destination appeared during install: ${finalRoot}`);
      return { root: finalRoot, marker: raced, cacheHit: true };
    }
    renameSync(extractedRoot, finalRoot);
    return { root: finalRoot, marker, cacheHit: false };
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export async function resolvePinnedSource(
  source: PinnedSource,
  options: SourceCacheOptions = {},
  requestedSelection?: PinnedSourceSelection,
): Promise<CachedSource> {
  const validated = validateSource(source);
  const selection = validateSelection(requestedSelection);
  const cacheDirectory = defaultCacheDirectory(options);
  ensureDirectory(cacheDirectory);
  const statePath = path.join(cacheDirectory, CACHE_STATE_FILE);
  const index = readCacheIndex(statePath);
  const cached = await installSourceArchive(validated, cacheDirectory, options.fetchImpl ?? fetch, selection);
  const previous = index.sources[validated.cacheKey];
  if (previous && (previous.repository !== cached.marker.repository || previous.commit !== cached.marker.commit ||
    previous.archiveSha256 !== cached.marker.archiveSha256 || previous.treeSha256 !== cached.marker.treeSha256 ||
    stableJson(previous.skippedSymlinks) !== stableJson(cached.marker.skippedSymlinks))) {
    throw new Error(`Agent source cache state does not match immutable cache: ${validated.cacheKey}`);
  }
  if (!previous) {
    writeCacheIndex(statePath, {
      version: 1,
      sources: {
        ...index.sources,
        [validated.cacheKey]: {
          repository: cached.marker.repository,
          commit: cached.marker.commit,
          archiveSha256: cached.marker.archiveSha256,
          treeSha256: cached.marker.treeSha256,
          skippedSymlinks: cached.marker.skippedSymlinks,
        },
      },
    });
  }
  return cached;
}

export function verifyCachedFile(cached: CachedSource, relativePath: string): Buffer {
  if (!validateRelativeFile(relativePath)) throw new Error(`Unsafe cached source file path: ${relativePath}`);
  const digest = cached.marker.files[relativePath];
  if (!digest) throw new Error(`Cached source file is not in verified inventory: ${relativePath}`);
  const bytes = readFileSync(path.join(cached.root, ...relativePath.split("/")));
  if (hash(bytes) !== digest) throw new Error(`Cached source file integrity check failed: ${relativePath}`);
  return bytes;
}

export function safeCachedPath(cached: CachedSource, relativePath: string): string | undefined {
  if (!validateRelativeFile(relativePath)) throw new Error(`Unsafe cached source path: ${relativePath}`);
  let current = cached.root;
  const segments = relativePath.split("/");
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const stat = inspectPath(current);
    if (!stat) return undefined;
    const final = index === segments.length - 1;
    if (!final && !stat.isDirectory()) throw new Error(`Cached source path is not a directory: ${relativePath}`);
    if (final && !stat.isDirectory() && !stat.isFile()) throw new Error(`Cached source path is not a regular file or directory: ${relativePath}`);
  }
  return current;
}

export function listCachedFiles(cached: CachedSource, relativeDirectory: string): string[] {
  const directory = safeCachedPath(cached, relativeDirectory);
  if (!directory) return [];
  const files: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => lexicalCompare(a.name, b.name))) {
      const absolute = path.join(current, entry.name);
      const stat = lstatSync(absolute);
      const relative = path.relative(cached.root, absolute).split(path.sep).join("/");
      if (stat.isSymbolicLink()) throw new Error(`Cached source contains symlink: ${relative}`);
      if (stat.isDirectory()) visit(absolute);
      else if (stat.isFile()) files.push(relative);
      else throw new Error(`Cached source contains unsupported entry: ${relative}`);
    }
  };
  const stat = lstatSync(directory);
  if (stat.isFile()) return [relativeDirectory];
  visit(directory);
  return files;
}
