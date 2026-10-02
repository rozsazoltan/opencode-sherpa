import { randomUUID } from "node:crypto";
import { readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import {
  atomicWrite,
  ensureDirectory,
  fileMode,
  hash,
  inspectPath,
  isRecord,
  lexicalCompare,
  readTextFile,
  stableJson,
} from "./agent-files.ts";
import type { SherpaAgentResolution, SherpaAgentSourceInfo, SherpaOmoAgent } from "./agent-sources.ts";

const CONFIG_FILES = ["oh-my-opencode-slim.jsonc", "oh-my-opencode-slim.json"] as const;
const CONFIG_DIRECTORY = ".opencode";
const PROMPTS_DIRECTORY = "oh-my-opencode-slim";
const SOURCE_NOTICE_FILE = "sherpa-agent-sources.md";
const AGENT_ID = /^sherpa-[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export interface SherpaOmoReconcileOptions {
  /** OpenCode project directory. */
  readonly projectDirectory: string;
  readonly dryRun?: boolean;
}

export interface SherpaOmoReconcileResult {
  readonly skipped: boolean;
  readonly reason?: "resolution-incomplete";
  readonly removedAgents: readonly string[];
  readonly installedAgents: readonly string[];
  readonly removedPrompts: readonly string[];
  readonly changedPaths: readonly string[];
}

interface PlannedWrite {
  readonly target: string;
  readonly contents: string;
  readonly previousContents: string | undefined;
  readonly mode: number;
}

interface PlannedRemoval {
  readonly target: string;
  readonly previousContents: string;
  readonly mode: number;
}

interface ReconcilePlan {
  readonly writes: PlannedWrite[];
  readonly removals: PlannedRemoval[];
}

function readConfig(source: string, configPath: string): Record<string, unknown> {
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
  if (isRecord(parsed.presets)) {
    for (const [name, preset] of Object.entries(parsed.presets)) {
      if (!isRecord(preset)) throw new Error(`OMO-Slim preset '${name}' must be an object: ${configPath}`);
    }
  }
  return parsed;
}

function setJsonc(source: string, jsonPath: readonly string[], value: unknown): string {
  return applyEdits(source, modify(source, [...jsonPath], value, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
  }));
}

function validateAgents(input: readonly SherpaOmoAgent[]): SherpaOmoAgent[] {
  if (!Array.isArray(input)) throw new Error("Resolved agents must be provided as an array.");
  const seen = new Set<string>();
  const agents = input.map((candidate: unknown): SherpaOmoAgent => {
    if (!isRecord(candidate) || typeof candidate.id !== "string" || !AGENT_ID.test(candidate.id)) {
      throw new Error("Resolved agent has invalid Sherpa ID.");
    }
    if (seen.has(candidate.id)) throw new Error(`Duplicate Sherpa agent ID '${candidate.id}'.`);
    seen.add(candidate.id);
    const fields = ["description", "orchestratorPrompt", "prompt", "sourceNamespace", "sourceRepository", "sourceCommit", "sourcePath"] as const;
    const values = {} as Record<(typeof fields)[number], string>;
    for (const field of fields) {
      if (typeof candidate[field] !== "string" || candidate[field].trim() === "") {
        throw new Error(`Sherpa agent '${candidate.id}' requires non-empty ${field}.`);
      }
      values[field] = candidate[field];
    }
    return {
      id: candidate.id,
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

function selectConfigPath(directory: string): string {
  const existing = CONFIG_FILES
    .map((name) => path.join(directory, name))
    .filter((file) => inspectPath(file) !== undefined);
  if (existing.length > 1) throw new Error(`Multiple OMO-Slim config files exist; refusing to choose: ${existing.join(", ")}`);
  return existing[0] ?? path.join(directory, CONFIG_FILES[0]);
}

function buildPlan(
  agents: readonly SherpaOmoAgent[],
  sources: readonly SherpaAgentSourceInfo[],
  configPath: string,
  promptDirectory: string,
): { plan: ReconcilePlan; removedAgents: string[]; removedPrompts: string[] } {
  const currentConfig = readTextFile(configPath);
  const configSource = currentConfig ?? "{}\n";
  const parsed = readConfig(configSource, configPath);
  const configAgents = isRecord(parsed.agents) ? parsed.agents : {};
  const presets = isRecord(parsed.presets) ? parsed.presets : {};
  const oldSherpaAgentIds = Object.keys(configAgents).filter((id) => id.startsWith("sherpa"));
  const oldPresetIds = Object.values(presets).flatMap((preset) => isRecord(preset)
    ? Object.keys(preset).filter((id) => id.startsWith("sherpa"))
    : []);
  const removedAgents = [...new Set([...oldSherpaAgentIds, ...oldPresetIds])].sort(lexicalCompare);
  const nextAgents = validateAgents(agents);
  let nextConfig = configSource;

  for (const id of oldSherpaAgentIds) nextConfig = setJsonc(nextConfig, ["agents", id], undefined);
  for (const [presetName, preset] of Object.entries(presets)) {
    if (!isRecord(preset)) continue;
    for (const id of Object.keys(preset).filter((name) => name.startsWith("sherpa"))) {
      nextConfig = setJsonc(nextConfig, ["presets", presetName, id], undefined);
    }
  }

  if (nextAgents.length > 0) {
    if (!Object.hasOwn(parsed, "agents")) nextConfig = setJsonc(nextConfig, ["agents"], {});
    if (!Object.hasOwn(parsed, "presets")) nextConfig = setJsonc(nextConfig, ["presets"], {});
    const currentPresets = isRecord(parsed.presets) ? parsed.presets : {};
    if (!Object.hasOwn(currentPresets, "codex")) nextConfig = setJsonc(nextConfig, ["presets", "codex"], {});
    if (!Object.hasOwn(currentPresets, "session")) nextConfig = setJsonc(nextConfig, ["presets", "session"], {});
    for (const agent of nextAgents) {
      nextConfig = setJsonc(nextConfig, ["agents", agent.id], {
        description: agent.description,
        orchestratorPrompt: agent.orchestratorPrompt,
      });
      const inheritModel = { inheritModelFrom: "session" };
      nextConfig = setJsonc(nextConfig, ["presets", "codex", agent.id], inheritModel);
      nextConfig = setJsonc(nextConfig, ["presets", "session", agent.id], inheritModel);
    }
  }

  const parseErrors: ParseError[] = [];
  parse(nextConfig, parseErrors, { allowTrailingComma: true });
  if (parseErrors.length > 0) throw new Error(`Generated OMO-Slim JSONC is malformed: ${configPath}`);

  const writes: PlannedWrite[] = [];
  const removals: PlannedRemoval[] = [];
  if (nextConfig !== configSource) {
    writes.push({ target: configPath, contents: nextConfig, previousContents: currentConfig, mode: fileMode(configPath) });
  }

  const promptEntries = inspectPath(promptDirectory)?.isDirectory()
    ? readdirSync(promptDirectory, { withFileTypes: true })
    : [];
  const promptFiles = new Map<string, string | undefined>();
  for (const entry of promptEntries) {
    if (!entry.name.startsWith("sherpa") || !entry.name.endsWith(".md") || entry.name === SOURCE_NOTICE_FILE) continue;
    const target = path.join(promptDirectory, entry.name);
    const stat = inspectPath(target);
    if (stat?.isFile()) promptFiles.set(entry.name, readTextFile(target));
  }

  for (const agent of nextAgents) {
    const name = `${agent.id}.md`;
    const target = path.join(promptDirectory, name);
    const previousContents = readTextFile(target);
    const contents = `${agent.prompt}\n`;
    promptFiles.delete(name);
    if (previousContents !== contents) {
      writes.push({ target, contents, previousContents, mode: fileMode(target) });
    }
  }
  for (const [name, contents] of promptFiles) {
    if (contents === undefined) continue;
    removals.push({ target: path.join(promptDirectory, name), previousContents: contents, mode: fileMode(path.join(promptDirectory, name)) });
  }

  const notice = sourceNotice(sources);
  const noticePath = path.join(promptDirectory, SOURCE_NOTICE_FILE);
  const existingNotice = readTextFile(noticePath);
  if (notice && existingNotice === undefined) {
    writes.push({ target: noticePath, contents: notice, previousContents: undefined, mode: fileMode(noticePath) });
  }

  return { plan: { writes, removals }, removedAgents, removedPrompts: removals.map(({ target }) => path.basename(target)) };
}

function commitPlan(plan: ReconcilePlan): void {
  const staged = new Map<PlannedWrite, string>();
  const committedWrites: PlannedWrite[] = [];
  const committedRemovals: PlannedRemoval[] = [];
  try {
    for (const write of plan.writes) {
      ensureDirectory(path.dirname(write.target));
      const temporary = path.join(path.dirname(write.target), `.${path.basename(write.target)}.tmp-${randomUUID()}`);
      staged.set(write, temporary);
      writeFileSync(temporary, write.contents, { flag: "wx", mode: write.mode });
    }

    for (const item of [...plan.writes, ...plan.removals]) {
      if (readTextFile(item.target) !== item.previousContents) {
        throw new Error(`OMO-Slim destination changed during reconciliation: ${item.target}`);
      }
    }

    for (const write of plan.writes) {
      if (readTextFile(write.target) !== write.previousContents) {
        throw new Error(`OMO-Slim destination changed during reconciliation: ${write.target}`);
      }
      const temporary = staged.get(write);
      if (!temporary) throw new Error(`Staged OMO-Slim write is missing: ${write.target}`);
      renameSync(temporary, write.target);
      staged.delete(write);
      committedWrites.push(write);
    }

    for (const removal of plan.removals) {
      if (readTextFile(removal.target) !== removal.previousContents) {
        throw new Error(`OMO-Slim destination changed during reconciliation: ${removal.target}`);
      }
      unlinkSync(removal.target);
      committedRemovals.push(removal);
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const removal of committedRemovals.reverse()) {
      try {
        if (inspectPath(removal.target)) throw new Error(`Cannot safely restore OMO-Slim prompt: ${removal.target}`);
        atomicWrite(removal.target, removal.previousContents, removal.mode);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    for (const write of committedWrites.reverse()) {
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
    for (const temporary of staged.values()) {
      try {
        rmSync(temporary, { force: true });
      } catch (cleanupError) {
        rollbackErrors.push(cleanupError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], "OMO-Slim reconciliation failed and rollback was incomplete.");
    }
    throw error;
  }
}

export function reconcileSherpaOmoAgents(
  resolution: SherpaAgentResolution,
  options: SherpaOmoReconcileOptions,
): SherpaOmoReconcileResult {
  if (resolution.diagnostics.length > 0) {
    return { skipped: true, reason: "resolution-incomplete", removedAgents: [], installedAgents: [], removedPrompts: [], changedPaths: [] };
  }

  const projectDirectory = path.resolve(options.projectDirectory);
  const projectStat = inspectPath(projectDirectory);
  if (!projectStat?.isDirectory()) throw new Error(`OpenCode project path is not a directory: ${projectDirectory}`);
  const configDirectory = path.join(projectDirectory, CONFIG_DIRECTORY);
  const configPath = selectConfigPath(configDirectory);
  const promptDirectory = path.join(configDirectory, PROMPTS_DIRECTORY);
  const configStat = inspectPath(configDirectory);
  if (configStat && !configStat.isDirectory()) throw new Error(`Project OMO-Slim config path is not a directory: ${configDirectory}`);
  const promptStat = inspectPath(promptDirectory);
  if (promptStat && !promptStat.isDirectory()) throw new Error(`Project OMO-Slim prompt path is not a directory: ${promptDirectory}`);
  inspectPath(configPath);
  const { plan, removedAgents, removedPrompts } = buildPlan(resolution.agents, resolution.sources, configPath, promptDirectory);
  if (!options.dryRun) commitPlan(plan);

  return {
    skipped: false,
    removedAgents,
    installedAgents: validateAgents(resolution.agents).map(({ id }) => id),
    removedPrompts,
    changedPaths: [
      ...plan.writes.map(({ target }) => target),
      ...plan.removals.map(({ target }) => target),
    ],
  };
}
