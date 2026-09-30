import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import * as tar from "tar";
import { parse as parseYaml } from "yaml";

const CONFIG_FILES = ["oh-my-opencode-slim.jsonc", "oh-my-opencode-slim.json"] as const;
const PROMPTS_DIRECTORY = "oh-my-opencode-slim";
const OWNERSHIP_FILE = ".sherpa-agent-ownership.json";
const SOURCE_NOTICE_FILE = "sherpa-agent-sources.md";
const CACHE_STATE_FILE = "state.json";
const CACHE_MARKER_FILE = ".sherpa-source-cache.json";
const AGENT_ID = /^sherpa-[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const NAMESPACE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const FULL_COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 20_000;
const MAX_PROMPT_BYTES = 4 * 1024 * 1024;
const NETWORK_TIMEOUT_MS = 30_000;

/** Immutable source selection. Repository accepts `owner/name` or a GitHub URL. */
export interface SherpaAgentSource {
  readonly repository: string;
  readonly commit: string;
  readonly directories: readonly string[];
  readonly namespace: string;
}

export const DEFAULT_SHERPA_AGENT_SOURCES: readonly SherpaAgentSource[] = [
  {
    repository: "VoltAgent/awesome-claude-code-subagents",
    commit: "82b73821baa7a911d5b14cfb6da238b7f0db6b42",
    namespace: "voltagent",
    directories: [
      "categories/01-core-development",
      "categories/02-language-specialists",
      "categories/04-quality-security",
      "categories/06-developer-experience",
      "categories/08-business-product",
      "categories/07-specialized-domains/api-documenter.md",
    ],
  },
];

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

export interface SherpaOmoSyncOptions {
  /** Explicit user-level OpenCode config directory. Useful for isolated tests. */
  readonly configDirectory?: string;
  readonly homeDirectory?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly sources?: readonly SherpaAgentSourceInfo[];
}

export interface SherpaOmoCollision {
  readonly id: string;
  readonly reason: "unowned-artifact" | "modified-owned-artifact";
}

export interface SherpaOmoSyncResult {
  readonly installed: readonly string[];
  readonly updated: readonly string[];
  readonly unchanged: readonly string[];
  readonly collisions: readonly SherpaOmoCollision[];
}

export interface SherpaOmoSyncDiagnostic {
  readonly id: string;
  readonly code: "collision";
  readonly message: string;
}

export interface SherpaOmoSyncReport extends SherpaOmoSyncResult {
  readonly diagnostics: readonly SherpaOmoSyncDiagnostic[];
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

interface OwnedAgent {
  readonly agentConfigHash: string;
  readonly sessionHash?: string;
  readonly codexHash?: string;
  readonly promptHash: string;
}

interface OwnershipManifest {
  readonly version: 2;
  readonly agents: Record<string, OwnedAgent>;
  readonly noticeHash?: string;
}

interface PlannedWrite {
  readonly target: string;
  readonly contents: string;
  readonly previousContents: string | undefined;
  readonly mode: number;
}

interface AgentConfigEntry {
  readonly description: string;
  readonly orchestratorPrompt: string;
}

interface SessionModelEntry {
  readonly inheritModelFrom: "session";
}

export function configuredSherpaAgentSources(value: unknown): readonly SherpaAgentSource[] {
  if (value === undefined) return DEFAULT_SHERPA_AGENT_SOURCES;
  if (Array.isArray(value)) return value as SherpaAgentSource[];
  if (!isRecord(value) || !Array.isArray(value.sources) ||
    (value.includeDefaults !== undefined && typeof value.includeDefaults !== "boolean")) {
    throw new TypeError("agentSources must be an array or an object with a sources array and optional includeDefaults boolean.");
  }
  return [
    ...(value.includeDefaults === false ? [] : DEFAULT_SHERPA_AGENT_SOURCES),
    ...(value.sources as SherpaAgentSource[]),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function lexicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort(lexicalCompare)
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function lstatOptional(target: string) {
  try {
    return lstatSync(target);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function pathSegments(absolutePath: string): { root: string; segments: string[] } {
  const absolute = path.resolve(absolutePath);
  const root = path.parse(absolute).root;
  return { root, segments: absolute.slice(root.length).split(path.sep).filter(Boolean) };
}

function inspectPath(target: string): ReturnType<typeof lstatSync> | undefined {
  const { root, segments } = pathSegments(target);
  let current = root;
  let finalStat: ReturnType<typeof lstatSync> | undefined;
  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index]!);
    const stat = lstatOptional(current);
    if (!stat) return undefined;
    if (stat.isSymbolicLink()) throw new Error(`Symlink path component is not allowed: ${current}`);
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new Error(`Path component must be a directory: ${current}`);
    }
    finalStat = stat;
  }
  return finalStat;
}

function ensureDirectory(target: string, mode = 0o700): void {
  const { root, segments } = pathSegments(target);
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = lstatOptional(current);
    if (!stat) {
      mkdirSync(current, { mode });
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Directory path contains unsafe component: ${current}`);
    }
  }
}

function assertRegularFile(target: string): boolean {
  const stat = inspectPath(target);
  if (!stat) return false;
  if (!stat.isFile()) throw new Error(`Destination must be a regular file: ${target}`);
  return true;
}

function readTextFile(target: string): string | undefined {
  if (!assertRegularFile(target)) return undefined;
  return readFileSync(target, "utf8");
}

function atomicWrite(target: string, contents: string | Buffer, mode = 0o600): void {
  const parent = path.dirname(target);
  ensureDirectory(parent);
  const temporary = path.join(parent, `.${path.basename(target)}.tmp-${randomUUID()}`);
  try {
    writeFileSync(temporary, contents, { flag: "wx", mode });
    renameSync(temporary, target);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch (cleanupError) {
      if (!isNodeError(cleanupError) || cleanupError.code !== "ENOENT") throw cleanupError;
    }
    throw error;
  }
}

function fileMode(target: string, fallback = 0o644): number {
  const stat = inspectPath(target);
  return stat ? Number(stat.mode) & 0o777 : fallback;
}

function commitWrites(writes: readonly PlannedWrite[]): void {
  const staged = new Map<PlannedWrite, string>();
  const committed: PlannedWrite[] = [];
  try {
    for (const write of writes) {
      ensureDirectory(path.dirname(write.target));
      const temp = path.join(path.dirname(write.target), `.${path.basename(write.target)}.tmp-${randomUUID()}`);
      staged.set(write, temp);
      writeFileSync(temp, write.contents, { flag: "wx", mode: write.mode });
    }
    for (const write of writes) {
      if (readTextFile(write.target) !== write.previousContents) {
        throw new Error(`OMO-Slim destination changed during sync: ${write.target}`);
      }
      const temp = staged.get(write);
      if (!temp) throw new Error(`Staged OMO-Slim write is missing: ${write.target}`);
      renameSync(temp, write.target);
      staged.delete(write);
      committed.push(write);
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const write of committed.reverse()) {
      try {
        if (readTextFile(write.target) !== write.contents) {
          throw new Error(`Cannot safely roll back changed OMO-Slim destination: ${write.target}`);
        }
        if (write.previousContents === undefined) rmSync(write.target, { force: true });
        else atomicWrite(write.target, write.previousContents, write.mode);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    for (const temp of staged.values()) {
      try {
        rmSync(temp, { force: true });
      } catch (cleanupError) {
        rollbackErrors.push(cleanupError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], "OMO-Slim sync failed and rollback was incomplete.");
    }
    throw error;
  }
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

function openCodeConfigDirectory(options: SherpaOmoSyncOptions): string {
  if (options.configDirectory?.trim()) return path.resolve(options.configDirectory.trim());
  const env = options.env ?? process.env;
  const home = path.resolve(options.homeDirectory ?? homedir());
  if (env.OPENCODE_CONFIG_DIR?.trim()) return path.resolve(env.OPENCODE_CONFIG_DIR.trim());
  if (env.XDG_CONFIG_HOME?.trim() && path.isAbsolute(env.XDG_CONFIG_HOME.trim())) {
    return path.join(path.resolve(env.XDG_CONFIG_HOME.trim()), "opencode");
  }
  return path.join(home, ".config", "opencode");
}

function selectConfigPath(directory: string): string {
  const existing = CONFIG_FILES.map((name) => path.join(directory, name)).filter((file) => inspectPath(file));
  if (existing.length > 1) throw new Error(`Multiple OMO-Slim config files exist; refusing to choose: ${existing.join(", ")}`);
  return existing[0] ?? path.join(directory, CONFIG_FILES[0]);
}

function readJsoncConfig(source: string, configPath: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const parsed: unknown = parse(source, errors, { allowTrailingComma: true });
  if (errors.length > 0) throw new Error(`OMO-Slim config is malformed: ${configPath}`);
  if (!isRecord(parsed)) throw new Error(`OMO-Slim config must contain a JSON object: ${configPath}`);
  if (parsed.agents !== undefined && !isRecord(parsed.agents)) {
    throw new Error(`OMO-Slim config 'agents' must be an object: ${configPath}`);
  }
  if (parsed.presets !== undefined && !isRecord(parsed.presets)) {
    throw new Error(`OMO-Slim config 'presets' must be an object: ${configPath}`);
  }
  const presets = isRecord(parsed.presets) ? parsed.presets : {};
  for (const [name, preset] of Object.entries(presets)) {
    if (!isRecord(preset)) throw new Error(`OMO-Slim preset '${name}' must be an object: ${configPath}`);
  }
  return parsed;
}

function readOwnershipManifest(file: string): OwnershipManifest {
  const source = readTextFile(file);
  if (source === undefined) return { version: 2, agents: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error(`Sherpa OMO ownership manifest is malformed: ${file}`);
  }
  if (!isRecord(parsed) || parsed.version !== 2 || !isRecord(parsed.agents) ||
    (parsed.noticeHash !== undefined && (typeof parsed.noticeHash !== "string" || !SHA256.test(parsed.noticeHash)))) {
    throw new Error(`Sherpa OMO ownership manifest is malformed: ${file}`);
  }
  const agents: Record<string, OwnedAgent> = {};
  for (const [id, owned] of Object.entries(parsed.agents)) {
    if (!AGENT_ID.test(id) || !isRecord(owned) ||
      typeof owned.agentConfigHash !== "string" || !SHA256.test(owned.agentConfigHash) ||
      (owned.sessionHash !== undefined && (typeof owned.sessionHash !== "string" || !SHA256.test(owned.sessionHash))) ||
      (owned.codexHash !== undefined && (typeof owned.codexHash !== "string" || !SHA256.test(owned.codexHash))) ||
      typeof owned.promptHash !== "string" || !SHA256.test(owned.promptHash)) {
      throw new Error(`Sherpa OMO ownership manifest is malformed: ${file}`);
    }
    agents[id] = {
      agentConfigHash: owned.agentConfigHash,
      ...(typeof owned.sessionHash === "string" ? { sessionHash: owned.sessionHash } : {}),
      ...(typeof owned.codexHash === "string" ? { codexHash: owned.codexHash } : {}),
      promptHash: owned.promptHash,
    };
  }
  return {
    version: 2,
    agents,
    ...(typeof parsed.noticeHash === "string" ? { noticeHash: parsed.noticeHash } : {}),
  };
}

function jsoncSet(source: string, jsonPath: readonly string[], value: unknown): string {
  return applyEdits(source, modify(source, [...jsonPath], value, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
  }));
}

function validateSyncAgents(input: readonly SherpaOmoAgent[]): SherpaOmoAgent[] {
  if (!Array.isArray(input)) throw new Error("Resolved agents must be provided as an array.");
  const seen = new Set<string>();
  const agents = input.map((candidate: unknown): SherpaOmoAgent => {
    if (!isRecord(candidate) || typeof candidate.id !== "string" || !AGENT_ID.test(candidate.id)) {
      throw new Error("Resolved agent has invalid Sherpa ID.");
    }
    const id = candidate.id;
    if (seen.has(id)) throw new Error(`Duplicate Sherpa agent ID '${id}'.`);
    seen.add(id);
    const textFields = ["description", "orchestratorPrompt", "prompt", "sourceNamespace", "sourceRepository", "sourceCommit", "sourcePath"] as const;
    const values = {} as Record<(typeof textFields)[number], string>;
    for (const field of textFields) {
      if (typeof candidate[field] !== "string" || candidate[field].trim() === "") {
        throw new Error(`Sherpa agent '${id}' requires non-empty ${field}.`);
      }
      values[field] = candidate[field];
    }
    return {
      id,
      description: values.description.trim(),
      orchestratorPrompt: values.orchestratorPrompt.trim(),
      prompt: values.prompt.trim(),
      sourceNamespace: values.sourceNamespace,
      sourceRepository: values.sourceRepository,
      sourceCommit: values.sourceCommit,
      sourcePath: values.sourcePath,
    };
  });
  return agents.sort((left, right) => lexicalCompare(left.id, right.id));
}

function configEntry(agent: SherpaOmoAgent): AgentConfigEntry {
  return { description: agent.description, orchestratorPrompt: agent.orchestratorPrompt };
}

function sessionEntry(): SessionModelEntry {
  return { inheritModelFrom: "session" };
}

function sourceNotice(sources: readonly SherpaAgentSourceInfo[]): string {
  if (sources.length === 0) return "";
  const sections = sources.map((source) => {
    const attribution = `Source: ${source.repository}@${source.commit}\nArchive SHA-256: ${source.archiveSha256}`;
    return source.licenseText.trim()
      ? `## ${source.repository}\n\n${attribution}\n\nLicense file: ${source.licensePath || "not found"}\n\n\`\`\`text\n${source.licenseText.trim()}\n\`\`\``
      : `## ${source.repository}\n\n${attribution}\n\nNo top-level license file was found in the source archive.`;
  });
  return `# Sherpa agent source notices\n\n${sections.join("\n\n---\n\n")}\n`;
}

function emptySyncReport(): SherpaOmoSyncReport {
  return { installed: [], updated: [], unchanged: [], collisions: [], diagnostics: [] };
}

export function syncSherpaOmoAgents(
  inputAgents: readonly SherpaOmoAgent[],
  options: SherpaOmoSyncOptions = {},
): SherpaOmoSyncReport {
  const agents = validateSyncAgents(inputAgents);
  if (agents.length === 0) return emptySyncReport();

  const configDirectory = openCodeConfigDirectory(options);
  const configPath = selectConfigPath(configDirectory);
  const promptDirectory = path.join(configDirectory, PROMPTS_DIRECTORY);
  const ownershipPath = path.join(promptDirectory, OWNERSHIP_FILE);
  inspectPath(configDirectory);
  inspectPath(configPath);
  inspectPath(promptDirectory);
  inspectPath(ownershipPath);

  const currentConfig = readTextFile(configPath);
  const configSource = currentConfig ?? "{}\n";
  const parsedConfig = readJsoncConfig(configSource, configPath);
  const configAgents = isRecord(parsedConfig.agents) ? parsedConfig.agents : {};
  const presets = isRecord(parsedConfig.presets) ? parsedConfig.presets : {};
  const sessionPreset = isRecord(presets.session) ? presets.session : {};
  const codexPreset = isRecord(presets.codex) ? presets.codex : {};
  const manifest = readOwnershipManifest(ownershipPath);
  const installed: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];
  const collisions: SherpaOmoCollision[] = [];
  const diagnostics: SherpaOmoSyncDiagnostic[] = [];
  const writes: PlannedWrite[] = [];
  const pending = new Map<string, {
    agent: SherpaOmoAgent;
    config: AgentConfigEntry;
    session: SessionModelEntry;
    prompt: string;
    previousPrompt: string | undefined;
    status: "installed" | "updated";
    ownsSession: boolean;
    ownsCodex: boolean;
  }>();

  for (const agent of agents) {
    const existingConfig = configAgents[agent.id];
    const existingSession = sessionPreset[agent.id];
    const existingCodex = codexPreset[agent.id];
    const promptPath = path.join(promptDirectory, `${agent.id}.md`);
    const existingPrompt = readTextFile(promptPath);
    const owned = manifest.agents[agent.id];
    const nextConfig = configEntry(agent);
    const nextSession = sessionEntry();
    const nextPrompt = `${agent.prompt}\n`;

    if (!owned) {
      if (existingConfig !== undefined || existingPrompt !== undefined ||
        existingSession !== undefined || existingCodex !== undefined) {
        collisions.push({ id: agent.id, reason: "unowned-artifact" });
        diagnostics.push({ id: agent.id, code: "collision", message: "Unowned OMO-Slim agent artifact was preserved." });
        continue;
      }
      pending.set(agent.id, {
        agent, config: nextConfig, session: nextSession, prompt: nextPrompt,
        previousPrompt: existingPrompt, status: "installed", ownsSession: existingSession === undefined,
        ownsCodex: existingCodex === undefined,
      });
      installed.push(agent.id);
      continue;
    }

    const sessionChanged = owned.sessionHash !== undefined &&
      (existingSession === undefined || hash(stableJson(existingSession)) !== owned.sessionHash);
    const codexChanged = owned.codexHash !== undefined &&
      (existingCodex === undefined || hash(stableJson(existingCodex)) !== owned.codexHash);
    if (existingConfig === undefined || existingPrompt === undefined ||
      hash(stableJson(existingConfig)) !== owned.agentConfigHash || hash(existingPrompt) !== owned.promptHash ||
      sessionChanged || codexChanged) {
      collisions.push({ id: agent.id, reason: "modified-owned-artifact" });
      diagnostics.push({ id: agent.id, code: "collision", message: "User-modified Sherpa-owned artifact was preserved." });
      continue;
    }

    const configSame = hash(stableJson(existingConfig)) === hash(stableJson(nextConfig));
    const sessionSame = !owned.sessionHash || hash(stableJson(existingSession)) === hash(stableJson(nextSession));
    const codexSame = !owned.codexHash || hash(stableJson(existingCodex)) === hash(stableJson(nextSession));
    if (configSame && sessionSame && codexSame && existingPrompt === nextPrompt) {
      unchanged.push(agent.id);
      continue;
    }
    pending.set(agent.id, {
      agent, config: nextConfig, session: nextSession, prompt: nextPrompt,
      previousPrompt: existingPrompt, status: "updated", ownsSession: owned.sessionHash !== undefined,
      ownsCodex: owned.codexHash !== undefined,
    });
    updated.push(agent.id);
  }

  // Session preset applies session-model inheritance to configured and discovered agents.
  const conflictedIds = new Set(collisions.map(({ id }) => id));
  const agentIds = new Set<string>(Object.keys(configAgents).filter((id) => !conflictedIds.has(id)));
  for (const { id } of agents) {
    if (!conflictedIds.has(id)) agentIds.add(id);
  }
  for (const preset of Object.values(presets)) {
    if (isRecord(preset)) {
      for (const id of Object.keys(preset)) {
        if (!conflictedIds.has(id)) agentIds.add(id);
      }
    }
  }

  let nextConfig = configSource;
  let hasConfigEdits = false;
  const hasConfigAgents = Object.hasOwn(parsedConfig, "agents");
  const hasPresets = Object.hasOwn(parsedConfig, "presets");
  if (!hasConfigAgents) {
    nextConfig = jsoncSet(nextConfig, ["agents"], {});
    hasConfigEdits = true;
  }
  if (!hasPresets) {
    nextConfig = jsoncSet(nextConfig, ["presets"], {});
    hasConfigEdits = true;
  }
  if (!Object.hasOwn(presets, "codex")) {
    nextConfig = jsoncSet(nextConfig, ["presets", "codex"], {});
    hasConfigEdits = true;
  }
  if (!Object.hasOwn(presets, "session")) {
    nextConfig = jsoncSet(nextConfig, ["presets", "session"], {});
    hasConfigEdits = true;
  }

  const nextManifestAgents: Record<string, OwnedAgent> = { ...manifest.agents };
  for (const [id, item] of pending) {
    const promptPath = path.join(promptDirectory, `${id}.md`);
    const currentPrompt = readTextFile(promptPath);
    if (currentPrompt !== item.previousPrompt) throw new Error(`OMO-Slim prompt changed during sync: ${id}`);
    const currentAgentConfig = configAgents[id];
    const currentSession = sessionPreset[id];
    const currentCodex = codexPreset[id];
    if (item.status === "installed" && currentAgentConfig !== undefined) {
      throw new Error(`Unowned OMO-Slim agent destination appeared during sync: ${id}`);
    }
    if (item.status === "updated" && !isRecord(currentAgentConfig)) {
      throw new Error(`Owned OMO-Slim agent destination disappeared during sync: ${id}`);
    }

    if (item.status === "installed") {
      nextConfig = jsoncSet(nextConfig, ["agents", id], item.config);
      hasConfigEdits = true;
    } else {
      for (const key of ["description", "orchestratorPrompt"] as const) {
        if ((currentAgentConfig as Record<string, unknown>)[key] !== item.config[key]) {
          nextConfig = jsoncSet(nextConfig, ["agents", id, key], item.config[key]);
          hasConfigEdits = true;
        }
      }
    }

    let sessionHash: string | undefined;
    if (item.ownsSession) {
      if (currentSession === undefined) {
        nextConfig = jsoncSet(nextConfig, ["presets", "session", id], item.session);
        hasConfigEdits = true;
        sessionHash = hash(stableJson(item.session));
      } else if (stableJson(currentSession) === stableJson(item.session)) {
        sessionHash = hash(stableJson(item.session));
      }
    }
    let codexHash: string | undefined;
    if (item.ownsCodex) {
      if (currentCodex === undefined) {
        nextConfig = jsoncSet(nextConfig, ["presets", "codex", id], item.session);
        hasConfigEdits = true;
        codexHash = hash(stableJson(item.session));
      } else if (stableJson(currentCodex) === stableJson(item.session)) {
        codexHash = hash(stableJson(item.session));
      }
    }
    nextManifestAgents[id] = {
      agentConfigHash: hash(stableJson(item.config)),
      ...(sessionHash ? { sessionHash } : {}),
      ...(codexHash ? { codexHash } : {}),
      promptHash: hash(item.prompt),
    };
    if (currentPrompt !== item.prompt) {
      writes.push({
        target: promptPath,
        contents: item.prompt,
        previousContents: currentPrompt,
        mode: fileMode(promptPath),
      });
    }
  }

  for (const id of [...agentIds].sort(lexicalCompare)) {
    const existing = sessionPreset[id];
    if (existing === undefined) {
      nextConfig = jsoncSet(nextConfig, ["presets", "session", id], sessionEntry());
      hasConfigEdits = true;
    }
  }

  let noticeHash = manifest.noticeHash;
  const notice = sourceNotice(options.sources ?? []);
  if (notice) {
    const noticePath = path.join(promptDirectory, SOURCE_NOTICE_FILE);
    const existingNotice = readTextFile(noticePath);
    if (!manifest.noticeHash && existingNotice === undefined) {
      writes.push({ target: noticePath, contents: notice, previousContents: undefined, mode: 0o644 });
      noticeHash = hash(notice);
    } else if (manifest.noticeHash && existingNotice !== undefined && hash(existingNotice) === manifest.noticeHash) {
      if (existingNotice !== notice) {
        writes.push({ target: noticePath, contents: notice, previousContents: existingNotice, mode: fileMode(noticePath) });
      }
      noticeHash = hash(notice);
    } else if (existingNotice !== undefined && hash(existingNotice) !== hash(notice)) {
      diagnostics.push({ id: "source-notice", code: "collision", message: "Existing source notice was preserved." });
      collisions.push({ id: "source-notice", reason: manifest.noticeHash ? "modified-owned-artifact" : "unowned-artifact" });
    }
  }

  if (hasConfigEdits) {
    const errors: ParseError[] = [];
    parse(nextConfig, errors, { allowTrailingComma: true });
    if (errors.length > 0) throw new Error(`Generated OMO-Slim JSONC is malformed: ${configPath}`);
    writes.push({ target: configPath, contents: nextConfig, previousContents: currentConfig, mode: fileMode(configPath) });
  }

  const manifestContents = `${JSON.stringify({ version: 2, agents: nextManifestAgents, ...(noticeHash ? { noticeHash } : {}) }, null, 2)}\n`;
  const existingManifestText = readTextFile(ownershipPath);
  if (manifestContents !== existingManifestText) {
    writes.push({
      target: ownershipPath,
      contents: manifestContents,
      previousContents: existingManifestText,
      mode: fileMode(ownershipPath, 0o600),
    });
  }

  ensureDirectory(configDirectory);
  ensureDirectory(promptDirectory);
  inspectPath(configPath);
  for (const id of pending.keys()) inspectPath(path.join(promptDirectory, `${id}.md`));
  inspectPath(path.join(promptDirectory, SOURCE_NOTICE_FILE));
  inspectPath(ownershipPath);
  commitWrites(writes);
  return { installed, updated, unchanged, collisions, diagnostics };
}
