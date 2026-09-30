import { randomUUID } from "node:crypto";
import { renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
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
  resolveRegularFileTarget,
  SHA256,
  stableJson,
} from "./agent-files.ts";
import type { SherpaAgentSourceInfo, SherpaOmoAgent } from "./agent-sources.ts";

const CONFIG_FILES = ["oh-my-opencode-slim.jsonc", "oh-my-opencode-slim.json"] as const;
const PROMPTS_DIRECTORY = "oh-my-opencode-slim";
const OWNERSHIP_FILE = ".sherpa-agent-ownership.json";
const SOURCE_NOTICE_FILE = "sherpa-agent-sources.md";
const AGENT_ID = /^sherpa-[a-z0-9]+(?:-[a-z0-9]+)*$/u;

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
  const existing = CONFIG_FILES
    .map((name) => resolveRegularFileTarget(path.join(directory, name)))
    .filter((file): file is string => file !== undefined);
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
