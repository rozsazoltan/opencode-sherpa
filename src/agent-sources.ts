import path from "node:path";
import { DEFAULT_SHERPA_AGENT_SOURCES, type SherpaAgentSource } from "./agent-source-catalog.ts";
import { parseAgentPrompt } from "./agent-prompt.ts";
import {
  defaultSherpaSourceCacheDirectory,
  listCachedFiles,
  normalizePinnedSource,
  resolvePinnedSource,
  safeCachedPath,
  verifyCachedFile,
  type CachedSource,
  type SourceCacheOptions,
} from "./source-cache.ts";
import { isRecord, lexicalCompare } from "./agent-files.ts";

const NAMESPACE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MAX_PROMPT_BYTES = 4 * 1024 * 1024;

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

export type SherpaAgentSourceOptions = SourceCacheOptions;

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

interface ValidatedSource extends SherpaAgentSource {
  readonly repository: string;
  readonly commit: string;
  readonly namespace: string;
  readonly directories: readonly string[];
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
  const namespace = String(source.namespace).trim();
  if (!NAMESPACE.test(namespace)) throw new Error(`Invalid agent source namespace '${namespace}'.`);
  const commit = String(source.commit).toLowerCase();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu.test(commit)) {
    throw new Error(`Agent source '${namespace}' requires an immutable full commit SHA.`);
  }
  if (!Array.isArray(source.directories) || source.directories.length === 0) {
    throw new Error(`Agent source '${namespace}' requires one or more selected directories.`);
  }
  const directories = [...new Set(source.directories.map((directory) => {
    if (typeof directory !== "string") throw new Error(`Invalid selected directory in agent source '${namespace}'.`);
    return validateDirectory(directory, namespace);
  }))].sort(lexicalCompare);
  const pinned = normalizePinnedSource({ repository: String(source.repository), commit });
  return { ...pinned, directories, namespace };
}

function agentName(relativePath: string): string {
  return path.posix.basename(relativePath).replace(/\.md$/iu, "").toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
}

function pathContext(relativePath: string): string {
  return path.posix.dirname(relativePath).split("/")
    .filter((segment) => segment && segment.toLowerCase() !== "categories")
    .map((segment) => segment.toLowerCase().replace(/^\d+[-_. ]*/u, "").replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, ""))
    .filter(Boolean)
    .join("-");
}

function collectAgents(source: ValidatedSource, cached: CachedSource): {
  agents: SherpaOmoAgent[];
  diagnostics: SherpaAgentDiagnostic[];
} {
  const agents: SherpaOmoAgent[] = [];
  const diagnostics: SherpaAgentDiagnostic[] = [];
  const promptFiles: string[] = [];
  const visited = new Set<string>();

  for (const directory of source.directories) {
    const selectedPath = safeCachedPath(cached, directory);
    if (!selectedPath) {
      diagnostics.push({
        namespace: source.namespace,
        repository: source.repository,
        commit: source.commit,
        code: "missing-directory",
        message: `Selected source path does not exist: ${directory}`,
      });
      continue;
    }
    const selected = listCachedFiles(cached, directory);
    for (const relativePath of selected) {
      if (path.posix.extname(relativePath).toLowerCase() !== ".md" ||
        path.posix.basename(relativePath).toLowerCase() === "readme.md" || visited.has(relativePath)) continue;
      visited.add(relativePath);
      if (!agentName(relativePath)) {
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
      promptFiles.push(relativePath);
    }
  }

  const basenameCounts = new Map<string, number>();
  for (const relativePath of promptFiles) {
    const name = agentName(relativePath);
    basenameCounts.set(name, (basenameCounts.get(name) ?? 0) + 1);
  }
  for (const relativePath of promptFiles) {
    const name = agentName(relativePath);
    const context = (basenameCounts.get(name) ?? 0) > 1 ? pathContext(relativePath) : "";
    const slug = [context, name].filter(Boolean).join("-");
    const id = `sherpa-${source.namespace}-${slug}`;
    try {
      const bytes = verifyCachedFile(cached, relativePath);
      if (bytes.byteLength > MAX_PROMPT_BYTES) throw new Error(`Agent prompt exceeds ${MAX_PROMPT_BYTES} byte limit.`);
      agents.push(parseAgentPrompt(bytes.toString("utf8"), id, source, relativePath));
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
  return { agents, diagnostics };
}

function sourceLicense(cached: CachedSource): { path: string; text: string } {
  const candidates = Object.keys(cached.marker.files).sort(lexicalCompare);
  const licensePath = candidates.find((relative) => {
    const basename = path.posix.basename(relative).toLowerCase();
    return basename === "license" || basename.startsWith("license.") ||
      basename === "copying" || basename.startsWith("copying.");
  });
  return licensePath
    ? { path: licensePath, text: verifyCachedFile(cached, licensePath).toString("utf8") }
    : { path: "", text: "" };
}

export function defaultSherpaAgentCacheDirectory(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory?: string,
): string {
  return defaultSherpaSourceCacheDirectory(env, homeDirectory);
}

export async function resolveSherpaAgentSources(
  sources: readonly SherpaAgentSource[],
  options: SherpaAgentSourceOptions = {},
): Promise<SherpaAgentResolution> {
  if (!Array.isArray(sources)) throw new Error("Agent sources must be provided as an array.");
  if (sources.length === 0) return { agents: [], sources: [], diagnostics: [] };
  const validated = sources.map(validateSource).sort((left, right) => lexicalCompare(left.namespace, right.namespace) ||
    lexicalCompare(left.repository, right.repository) || lexicalCompare(left.commit, right.commit));
  const agents: SherpaOmoAgent[] = [];
  const sourceInfo: SherpaAgentSourceInfo[] = [];
  const diagnostics: SherpaAgentDiagnostic[] = [];

  for (const source of validated) {
    try {
      const cached = await resolvePinnedSource(source, options);
      const cachedSource = { ...source, repository: cached.marker.repository, commit: cached.marker.commit };
      const result = collectAgents(cachedSource, cached);
      const license = sourceLicense(cached);
      agents.push(...result.agents);
      diagnostics.push(...result.diagnostics);
      sourceInfo.push({
        namespace: source.namespace,
        repository: cached.marker.repository,
        commit: cached.marker.commit,
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
