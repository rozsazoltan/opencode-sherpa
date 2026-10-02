import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import {
  atomicWrite,
  ensureDirectory,
  hash,
  inspectPath,
  isRecord,
  readTextFile,
} from "./agent-files.ts";
import { configuredSherpaAgentSources, resolveSherpaAgentSources, type SherpaAgentResolution } from "./agent-sources.ts";
import { createEngineeringInstructions } from "./instructions.ts";
import { createRemoteMcpServers } from "./mcp.ts";
import { defaultOpenCodeConfigDirectory, readGlobalMcpServerNames } from "./opencode-config.ts";
import { reconcileSherpaOmoAgents } from "./omo-agents.ts";
import { configuredProjectDetection, detectProject } from "./project-detection.ts";
import { configuredContentSelection, selectProjectContent, selectProjectSkillIds } from "./project-selection.ts";
import {
  configuredSherpaSkillSources,
  declaredSkillIds,
  resolveSherpaSkillSources,
  type SherpaSkillResolution,
} from "./skill-sources.ts";
import { loadSherpaTuning, type SherpaTuning } from "./tuning.ts";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHERPA_CONFIG_FILES = ["opencode-sherpa.jsonc", "opencode-sherpa.json"] as const;
const OPENCODE_CONFIG_FILES = ["opencode.jsonc", "opencode.json"] as const;
const MANIFEST_PATH = ".opencode/.sherpa-files.json";
const INSTRUCTIONS_BEGIN = "<!-- opencode-sherpa:begin -->";
const INSTRUCTIONS_END = "<!-- opencode-sherpa:end -->";

interface PlannedFileWrite {
  readonly target: string;
  readonly relativePath: string;
  readonly contents: Buffer;
  readonly previousContents: Buffer | undefined;
}

interface PlannedFileRemoval {
  readonly target: string;
  readonly relativePath: string;
  readonly previousContents: Buffer;
}

interface McpConfigPlan {
  readonly write: PlannedFileWrite | undefined;
  readonly localServerNames: readonly string[];
  readonly builtInServerNames: readonly string[];
}

interface ArtifactPlan {
  readonly writes: PlannedFileWrite[];
  readonly removals: PlannedFileRemoval[];
  readonly conflicts: string[];
}

interface ProjectSettings {
  readonly agentSources?: unknown;
  readonly skillSources?: unknown;
  readonly language?: unknown;
  readonly detection?: unknown;
  readonly agents?: unknown;
  readonly commands?: unknown;
  readonly instructions?: unknown;
  readonly skills?: unknown;
}

export interface SyncOptions {
  readonly projectDirectory: string;
  readonly dryRun?: boolean;
  readonly packageRoot?: string;
}

export interface SyncDependencies {
  readonly resolveSources?: typeof resolveSherpaAgentSources;
  readonly resolveSkillSources?: typeof resolveSherpaSkillSources;
  readonly packageRoot?: string;
  readonly globalConfigDirectory?: string;
}

export interface SyncResult {
  readonly messages: readonly string[];
}

function parseJsoncObject(source: string, label: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const parsed: unknown = parse(source, errors, { allowTrailingComma: true });
  if (errors.length > 0) throw new Error(`${label} is malformed.`);
  if (!isRecord(parsed)) throw new Error(`${label} must contain a JSON object.`);
  return parsed;
}

function selectConfigPath(directory: string, names: readonly string[], label: string): string {
  const existing = names.map((name) => path.join(directory, name))
    .filter((file) => inspectPath(file) !== undefined);
  if (existing.length > 1) throw new Error(`Multiple ${label} files exist; refusing to choose: ${existing.join(", ")}`);
  for (const file of existing) {
    if (!inspectPath(file)?.isFile()) throw new Error(`${label} must be a regular file: ${file}`);
  }
  return existing[0] ?? path.join(directory, names[names.length - 1]!);
}

function loadProjectSettings(projectDirectory: string): ProjectSettings {
  const configPath = selectConfigPath(projectDirectory, SHERPA_CONFIG_FILES, "OpenCode Sherpa config");
  const source = readTextFile(configPath);
  if (source === undefined) return {};
  const parsed = parseJsoncObject(source, `OpenCode Sherpa config ${configPath}`);
  const unsupported = Object.keys(parsed).find((key) =>
    !["agentSources", "skillSources", "language", "detection", "agents", "commands", "instructions", "skills"].includes(key));
  if (unsupported) throw new Error(`Unsupported OpenCode Sherpa config option: ${unsupported}.`);
  return parsed;
}

function planMcpConfig(
  projectDirectory: string,
  globalServerNames: readonly string[],
  globalConfigDirectory: string,
): McpConfigPlan {
  const configPath = selectConfigPath(projectDirectory, OPENCODE_CONFIG_FILES, "OpenCode config");
  const currentContents = readTextFile(configPath);
  const source = currentContents ?? "{}\n";
  const parsed = parseJsoncObject(source, `OpenCode config ${configPath}`);
  if (parsed.mcp !== undefined && !isRecord(parsed.mcp)) {
    throw new Error(`OpenCode config 'mcp' must be an object: ${configPath}`);
  }
  const mcp = isRecord(parsed.mcp) ? parsed.mcp : {};
  if (mcp.servers !== undefined && !isRecord(mcp.servers)) {
    throw new Error(`OpenCode config 'mcp.servers' must be an object: ${configPath}`);
  }
  const existingServers = isRecord(mcp.servers) ? mcp.servers : {};
  const globalServerSet = new Set(globalServerNames);
  const servers = createRemoteMcpServers({
    ...existingServers,
    ...Object.fromEntries(globalServerNames.map((name) => [name, true])),
  }, { globalConfigDirectory });
  const builtInServerNames = Object.keys(servers);
  const additions = Object.entries(servers).filter(([name]) =>
    !Object.hasOwn(existingServers, name) && !globalServerSet.has(name));
  const localServerNames = Object.keys(existingServers);
  if (additions.length === 0) return { write: undefined, localServerNames, builtInServerNames };
  let next = source;
  if (!Object.hasOwn(parsed, "mcp")) {
    next = applyEdits(next, modify(next, ["mcp"], {}, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
    }));
  }
  if (!Object.hasOwn(mcp, "servers")) {
    next = applyEdits(next, modify(next, ["mcp", "servers"], {}, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
    }));
  }
  for (const [name, server] of additions) {
    next = applyEdits(next, modify(next, ["mcp", "servers", name], server, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
    }));
  }
  if (next === source) return { write: undefined, localServerNames, builtInServerNames };
  return {
    write: {
      target: configPath,
      relativePath: path.relative(projectDirectory, configPath).split(path.sep).join("/"),
      contents: Buffer.from(next),
      previousContents: currentContents === undefined ? undefined : Buffer.from(currentContents),
    },
    localServerNames,
    builtInServerNames,
  };
}

function instructionsContent(tuning: SherpaTuning, language: unknown): string {
  const text = [createEngineeringInstructions(language), ...tuning.instructions.map(({ content }) => content.trim())]
    .filter((instruction) => instruction.length > 0)
    .join("\n\n");
  return `${INSTRUCTIONS_BEGIN}\n${text}\n${INSTRUCTIONS_END}`;
}

function mergeInstructions(existing: string | undefined, block: string, file: string): string {
  if (existing === undefined || existing.length === 0) return `${block}\n`;
  const beginCount = existing.split(INSTRUCTIONS_BEGIN).length - 1;
  const endCount = existing.split(INSTRUCTIONS_END).length - 1;
  if (beginCount !== endCount || beginCount > 1) {
    throw new Error(`OpenCode Sherpa instruction markers are malformed: ${file}`);
  }
  if (beginCount === 1) {
    const start = existing.indexOf(INSTRUCTIONS_BEGIN);
    const end = existing.indexOf(INSTRUCTIONS_END) + INSTRUCTIONS_END.length;
    return `${existing.slice(0, start)}${block}${existing.slice(end)}`;
  }
  return `${existing.replace(/\s*$/u, "")}\n\n${block}\n`;
}

function collectSkillFiles(tuning: SherpaTuning): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (const skill of tuning.skills) {
    const targetRoot = path.join(".opencode", "skills", ...skill.id.split("/"));
    if (skill.files) {
      for (const [relative, contents] of skill.files) {
        files.set(path.posix.join(targetRoot.split(path.sep).join("/"), relative), Buffer.from(contents));
      }
      continue;
    }
    const sourceRoot = path.dirname(skill.path);
    const visit = (sourceDirectory: string, relativeDirectory: string): void => {
      const stat = lstatSync(sourceDirectory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`Skill source path must be a real directory: ${sourceDirectory}`);
      }
      for (const entry of readdirSync(sourceDirectory, { withFileTypes: true })) {
        const source = path.join(sourceDirectory, entry.name);
        const relative = path.join(relativeDirectory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          visit(source, relative);
          continue;
        }
        const fileStat = lstatSync(source);
        if (!fileStat.isFile()) continue;
        const targetRelative = path.join(targetRoot, relative).split(path.sep).join("/");
        files.set(targetRelative, readFileSync(source));
      }
    };
    visit(sourceRoot, "");
  }
  return files;
}

function createDesiredArtifactFiles(tuning: SherpaTuning, language: unknown, projectDirectory: string): Map<string, Buffer> {
  const desired = collectSkillFiles(tuning);
  for (const command of tuning.commands) {
    const target = path.join(".opencode", "commands", ...command.name.split("/")) + ".md";
    desired.set(target.split(path.sep).join("/"), readFileSync(command.path));
  }
  const instructionsPath = path.join(projectDirectory, "AGENTS.md");
  const currentInstructions = readTextFile(instructionsPath);
  const merged = mergeInstructions(currentInstructions, instructionsContent(tuning, language), instructionsPath);
  desired.set("AGENTS.md", Buffer.from(merged));
  return desired;
}

function parseManifest(source: string | undefined, file: string): Record<string, string> {
  if (source === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error(`OpenCode Sherpa file manifest is malformed: ${file}`);
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.files)) {
    throw new Error(`OpenCode Sherpa file manifest is malformed: ${file}`);
  }
  const files: Record<string, string> = {};
  for (const [relative, digest] of Object.entries(parsed.files)) {
    const segments = relative.split("/");
    if ((!relative.startsWith(".opencode/skills/") && !relative.startsWith(".opencode/commands/")) ||
      path.posix.isAbsolute(relative) ||
      segments.some((segment) => !segment || segment === "." || segment === "..") ||
      typeof digest !== "string" || !/^[a-f0-9]{64}$/u.test(digest)) {
      throw new Error(`OpenCode Sherpa file manifest is malformed: ${file}`);
    }
    files[relative] = digest;
  }
  return files;
}

function readBuffer(target: string): Buffer | undefined {
  const stat = inspectPath(target);
  if (!stat) return undefined;
  if (!stat.isFile()) throw new Error(`Destination must be a regular file: ${target}`);
  return readFileSync(target);
}

function planArtifacts(projectDirectory: string, tuning: SherpaTuning, language: unknown): ArtifactPlan {
  const manifestPath = path.join(projectDirectory, MANIFEST_PATH);
  const manifestSource = readTextFile(manifestPath);
  const previousFiles = parseManifest(manifestSource, manifestPath);
  const desiredFiles = createDesiredArtifactFiles(tuning, language, projectDirectory);
  const nextFiles: Record<string, string> = {};
  const writes: PlannedFileWrite[] = [];
  const removals: PlannedFileRemoval[] = [];
  const conflicts: string[] = [];
  const blockedSkillRoots = new Set<string>();

  for (const skill of tuning.skills) {
    const relativeRoot = `.opencode/skills/${skill.id}/`;
    const skillFile = `${relativeRoot}SKILL.md`;
    const contents = desiredFiles.get(skillFile);
    if (!contents) continue;
    const current = readBuffer(path.join(projectDirectory, ...skillFile.split("/")));
    const previousHash = previousFiles[skillFile];
    if (current !== undefined && (previousHash === undefined ||
      (hash(current) !== previousHash && hash(current) !== hash(contents)))) {
      blockedSkillRoots.add(relativeRoot);
      conflicts.push(skillFile);
    }
  }

  for (const [relativePath, contents] of desiredFiles) {
    if ([...blockedSkillRoots].some((root) => relativePath.startsWith(root))) continue;
    const target = path.join(projectDirectory, ...relativePath.split("/"));
    const previousContents = readBuffer(target);
    const previousHash = previousFiles[relativePath];
    const nextHash = hash(contents);
    if (relativePath === "AGENTS.md") {
      if (!buffersEqual(previousContents, contents)) {
        writes.push({ target, relativePath, contents, previousContents });
      }
      continue;
    }
    if (previousContents === undefined) {
      if (previousHash !== undefined) conflicts.push(relativePath);
      writes.push({ target, relativePath, contents, previousContents, });
      nextFiles[relativePath] = nextHash;
      continue;
    }

    const currentHash = hash(previousContents);
    if (previousHash === undefined) {
      if (currentHash !== nextHash) conflicts.push(relativePath);
      continue;
    }
    if (currentHash !== previousHash && currentHash !== nextHash) {
      conflicts.push(relativePath);
      continue;
    }
    nextFiles[relativePath] = nextHash;
    if (currentHash !== nextHash) writes.push({ target, relativePath, contents, previousContents });
  }

  for (const [relativePath, previousHash] of Object.entries(previousFiles)) {
    if (desiredFiles.has(relativePath)) continue;
    const target = path.join(projectDirectory, ...relativePath.split("/"));
    const previousContents = readBuffer(target);
    if (previousContents === undefined) continue;
    if (hash(previousContents) !== previousHash) {
      conflicts.push(relativePath);
      continue;
    }
    removals.push({ target, relativePath, previousContents });
  }

  const manifestContents = Buffer.from(`${JSON.stringify({ version: 1, files: nextFiles }, null, 2)}\n`);
  if (manifestSource !== manifestContents.toString("utf8")) {
    writes.push({
      target: manifestPath,
      relativePath: MANIFEST_PATH,
      contents: manifestContents,
      previousContents: manifestSource === undefined ? undefined : Buffer.from(manifestSource),
    });
  }
  return { writes, removals, conflicts: [...new Set(conflicts)].sort() };
}

function applyArtifactPlan(plan: ArtifactPlan): void {
  const manifestWrite = plan.writes.find(({ relativePath }) => relativePath === MANIFEST_PATH);
  const artifactWrites = plan.writes.filter(({ relativePath }) => relativePath !== MANIFEST_PATH);
  for (const item of [...artifactWrites, ...plan.removals, ...(manifestWrite ? [manifestWrite] : [])]) {
    const current = readBuffer(item.target);
    if (!buffersEqual(current, item.previousContents)) {
      throw new Error(`OpenCode Sherpa destination changed during sync: ${item.target}`);
    }
  }
  for (const write of artifactWrites) atomicWrite(write.target, write.contents);
  for (const removal of plan.removals) unlinkSync(removal.target);
  if (manifestWrite) atomicWrite(manifestWrite.target, manifestWrite.contents);
}

function buffersEqual(left: Buffer | undefined, right: Buffer | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.equals(right);
}

function applyConfigWrite(write: PlannedFileWrite): void {
  ensureDirectory(path.dirname(write.target));
  if (!buffersEqual(readBuffer(write.target), write.previousContents)) {
    throw new Error(`OpenCode config changed during sync: ${write.target}`);
  }
  atomicWrite(write.target, write.contents);
}

function printActions(
  projectDirectory: string,
  plan: ArtifactPlan,
  mcpWrite: PlannedFileWrite | undefined,
  omoPaths: readonly string[],
  dryRun: boolean,
): string[] {
  const prefix = dryRun ? "Would" : "Will";
  const messages = [
    ...plan.writes.map(({ relativePath }) => `${prefix} write ${relativePath}`),
    ...plan.removals.map(({ relativePath }) => `${prefix} remove ${relativePath}`),
    ...(mcpWrite ? [`${prefix} write ${mcpWrite.relativePath}`] : []),
    ...omoPaths.map((file) => `${prefix} update ${path.relative(projectDirectory, file).split(path.sep).join("/")}`),
    ...plan.conflicts.map((file) => `Preserved user file ${file}`),
  ];
  if (messages.length === 0) messages.push(dryRun ? "No changes needed." : "Project is up to date.");
  return messages;
}

function printSelection(
  detection: ReturnType<typeof detectProject>,
  selection: ReturnType<typeof selectProjectContent>,
): string[] {
  const messages = [
    `Detected stacks: ${detection.stacks.length > 0 ? detection.stacks.join(", ") : "none"}`,
    `Detected features: ${detection.features.length > 0 ? detection.features.join(", ") : "none"}`,
  ];
  if (detection.evidence.length === 0) {
    messages.push("Manifest evidence: none");
  } else {
    for (const evidence of detection.evidence) {
      messages.push(`Manifest evidence ${evidence.path}: ${evidence.stack}; features: ${evidence.features.length > 0 ? evidence.features.join(", ") : "none"}`);
    }
  }
  messages.push(selection.agents.length > 0 ? "Selected agents:" : "Selected agents: none");
  for (const reason of selection.reasons.filter(({ kind }) => kind === "agent")) {
    messages.push(`- ${reason.id}: ${reason.reason}`);
  }
  messages.push(selection.skills.length > 0 ? "Selected skills:" : "Selected skills: none");
  for (const reason of selection.reasons.filter(({ kind }) => kind === "skill")) {
    messages.push(`- ${reason.id}: ${reason.reason}`);
  }
  messages.push(selection.commands.length > 0 ? "Selected commands:" : "Selected commands: none");
  for (const reason of selection.reasons.filter(({ kind }) => kind === "command")) {
    messages.push(`- ${reason.id}: ${reason.reason}`);
  }
  messages.push(selection.instructions.length > 0 ? "Selected instructions:" : "Selected instructions: none");
  for (const reason of selection.reasons.filter(({ kind }) => kind === "instruction")) {
    messages.push(`- ${reason.id}: ${reason.reason}`);
  }
  return messages;
}

function validateExternalSkillResolution(
  resolution: SherpaSkillResolution,
  requestedIds: readonly string[],
): void {
  if (!resolution || !Array.isArray(resolution.skills) || !Array.isArray(resolution.sources) ||
    !Array.isArray(resolution.diagnostics)) {
    throw new Error("Skill source resolver returned an invalid result.");
  }
  const requested = new Set(requestedIds);
  const seenSkills = new Set<string>();
  const skillFilesById = new Map<string, Map<string, Buffer>>();
  for (const skill of resolution.skills) {
    if (!skill || typeof skill.id !== "string" || !requested.has(skill.id)) {
      throw new Error(`Skill source resolver returned unrequested skill '${skill?.id ?? "<invalid>"}'.`);
    }
    if (seenSkills.has(skill.id)) throw new Error(`Skill source resolver returned duplicate skill '${skill.id}'.`);
    seenSkills.add(skill.id);
    if (!skill.files || typeof skill.files[Symbol.iterator] !== "function") {
      throw new Error(`Skill source resolver did not provide a file map for '${skill.id}'.`);
    }
    const fileNames = new Set<string>();
    const fileContents = new Map<string, Buffer>();
    for (const entry of skill.files) {
      if (!Array.isArray(entry) || entry.length !== 2) {
        throw new Error(`Skill source resolver returned an invalid file map for '${skill.id}'.`);
      }
      const [relative, contents] = entry as [unknown, unknown];
      if (typeof relative !== "string" || !relative || relative.includes("\\") || relative.includes("\0") ||
        relative.startsWith("/") || /^[A-Za-z]:/u.test(relative) ||
        relative.split("/").some((segment) => !segment || segment === "." || segment === "..") ||
        !Buffer.isBuffer(contents)) {
        throw new Error(`Skill source resolver returned an unsafe file for '${skill.id}'.`);
      }
      if (fileNames.has(relative)) throw new Error(`Skill source resolver returned duplicate file '${relative}' for '${skill.id}'.`);
      fileNames.add(relative);
      fileContents.set(relative, contents);
    }
    if (!fileNames.has("SKILL.md") || !fileNames.has("SHERPA-SOURCE.json")) {
      throw new Error(`Skill source resolver returned an incomplete file map for '${skill.id}'.`);
    }
    skillFilesById.set(skill.id, fileContents);
  }
  const missing = requestedIds.find((id) => !seenSkills.has(id));
  if (missing) throw new Error(`Skill source resolver omitted selected skill '${missing}'.`);

  const seenSourceSkills = new Set<string>();
  for (const source of resolution.sources) {
    if (!source || typeof source.namespace !== "string" || typeof source.repository !== "string" ||
      typeof source.commit !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu.test(source.commit) ||
      typeof source.archiveSha256 !== "string" || !/^[a-f0-9]{64}$/iu.test(source.archiveSha256) ||
      !Array.isArray(source.skills)) {
      throw new Error("Skill source resolver returned invalid source provenance.");
    }
    for (const item of source.skills) {
      if (!item || typeof item.id !== "string" || !requested.has(item.id) || seenSourceSkills.has(item.id) ||
        typeof item.sourcePath !== "string" || !item.sourcePath || !item.licenseEvidence) {
        throw new Error("Skill source resolver returned invalid selected-skill provenance.");
      }
      seenSourceSkills.add(item.id);
      const evidence = item.licenseEvidence;
      if (typeof evidence !== "object" || evidence === null) {
        throw new Error(`Skill source resolver returned invalid license evidence for '${item.id}'.`);
      }
      if (evidence.kind === "file") {
        if (typeof evidence.path !== "string" || !evidence.path || !/^[a-f0-9]{64}$/iu.test(evidence.sha256)) {
          throw new Error(`Skill source resolver returned invalid license evidence for '${item.id}'.`);
        }
        const licenseBytes = skillFilesById.get(item.id)?.get("SHERPA-LICENSE.txt");
        if (!licenseBytes || hash(licenseBytes) !== evidence.sha256) {
          throw new Error(`Skill source resolver returned missing or mismatched license bytes for '${item.id}'.`);
        }
      } else if (evidence.kind !== "declared" || typeof evidence.identifier !== "string" || !evidence.identifier) {
        throw new Error(`Skill source resolver returned invalid license evidence for '${item.id}'.`);
      }
    }
  }
  if (seenSourceSkills.size !== requested.size) throw new Error("Skill source resolver returned incomplete selected-skill provenance.");
}

function skillSourceMessages(resolution: SherpaSkillResolution): string[] {
  const messages: string[] = [];
  for (const source of resolution.sources) {
    for (const skill of source.skills) {
      const license = skill.licenseEvidence.kind === "file"
        ? `file ${skill.licenseEvidence.path} (${skill.licenseEvidence.sha256})`
        : `declared ${skill.licenseEvidence.identifier}`;
      messages.push(`Skill source ${skill.id}: ${source.repository}@${source.commit}/${skill.sourcePath}; license ${license}`);
    }
  }
  return messages.sort();
}

function assertSkillResolutionSucceeded(resolution: SherpaSkillResolution): void {
  if (!resolution || !Array.isArray(resolution.diagnostics)) {
    throw new Error("Skill source resolver returned an invalid result.");
  }
  if (resolution.diagnostics.length === 0) return;
  const details = resolution.diagnostics
    .map(({ namespace, code, message, skillId, sourcePath }) =>
      `- ${namespace} (${code})${skillId ? ` ${skillId}` : ""}${sourcePath ? ` ${sourcePath}` : ""}: ${message}`)
    .join("\n");
  throw new Error(`Skill source resolution failed; project files were not changed.\n${details}`);
}

export async function syncProject(
  options: SyncOptions,
  dependencies: SyncDependencies = {},
): Promise<SyncResult> {
  const projectDirectory = path.resolve(options.projectDirectory);
  const projectStat = inspectPath(projectDirectory);
  if (!projectStat?.isDirectory()) throw new Error(`OpenCode project path is not a directory: ${projectDirectory}`);
  const globalConfigDirectory = dependencies.globalConfigDirectory ?? defaultOpenCodeConfigDirectory();
  const globalServerNames = readGlobalMcpServerNames(globalConfigDirectory);
  const settings = loadProjectSettings(projectDirectory);
  const sources = configuredSherpaAgentSources(settings.agentSources);
  const skillSources = configuredSherpaSkillSources(settings.skillSources);
  const detectionOptions = configuredProjectDetection(settings.detection === undefined ? {} : settings.detection);
  const agentSelection = configuredContentSelection(settings.agents);
  const commandSelection = configuredContentSelection(settings.commands);
  const instructionSelection = configuredContentSelection(settings.instructions);
  const skillSelection = configuredContentSelection(settings.skills);
  const tuning = loadSherpaTuning(options.packageRoot ?? dependencies.packageRoot ?? PACKAGE_ROOT);
  const detection = detectProject(projectDirectory, detectionOptions);
  const declaredIds = declaredSkillIds(skillSources);
  const availableSkillIds = [...tuning.skills.map(({ id }) => id), ...declaredIds];
  const selectedSkillIds = selectProjectSkillIds(detection, availableSkillIds, skillSelection);
  const declaredIdSet = new Set(declaredIds);
  const selectedExternalSkillIds = selectedSkillIds.filter((id) => declaredIdSet.has(id));
  const dryRun = options.dryRun === true;
  const agentResolver = dependencies.resolveSources ?? resolveSherpaAgentSources;
  const skillResolver = dependencies.resolveSkillSources ?? resolveSherpaSkillSources;
  let temporaryCache: string | undefined;
  let resolution: SherpaAgentResolution;
  let skillResolution: SherpaSkillResolution = { skills: [], sources: [], diagnostics: [] };
  try {
    const resolutionOptions = dryRun && (sources.length > 0 || selectedExternalSkillIds.length > 0)
      ? (() => {
          temporaryCache = mkdtempSync(path.join(os.tmpdir(), "opencode-sherpa-dry-run-"));
          return { cacheDirectory: temporaryCache };
        })()
      : undefined;
    if (selectedExternalSkillIds.length > 0) {
      skillResolution = await skillResolver(skillSources, {
        ...resolutionOptions,
        skillIds: selectedExternalSkillIds,
      });
      assertSkillResolutionSucceeded(skillResolution);
      validateExternalSkillResolution(skillResolution, selectedExternalSkillIds);
    }
    resolution = await agentResolver(sources, resolutionOptions);
  } finally {
    if (temporaryCache) rmSync(temporaryCache, { recursive: true, force: true });
  }
  if (resolution.diagnostics.length > 0) {
    const details = resolution.diagnostics
      .map(({ namespace, code, message }) => `- ${namespace} (${code}): ${message}`)
      .join("\n");
    throw new Error(`Agent source resolution failed; project files were not changed.\n${details}`);
  }

  const mergedTuning: SherpaTuning = {
    ...tuning,
    skills: [...tuning.skills, ...skillResolution.skills],
  };
  const mergedSkillIds = new Set(mergedTuning.skills.map(({ id }) => id));
  const finalSkillSelection = {
    ...skillSelection,
    include: skillSelection.include.filter((id) => mergedSkillIds.has(id)),
    exclude: skillSelection.exclude.filter((id) => mergedSkillIds.has(id)),
  };
  const selection = selectProjectContent(detection, resolution.agents, mergedTuning, {
    agents: agentSelection,
    commands: commandSelection,
    instructions: instructionSelection,
    skills: finalSkillSelection,
  });
  const finalSkillIds = selection.skills.map(({ id }) => id).sort();
  if (finalSkillIds.length !== selectedSkillIds.length ||
    finalSkillIds.some((id, index) => id !== selectedSkillIds[index])) {
    throw new Error("Selected skill IDs changed during resolution; project files were not changed.");
  }
  const filteredResolution: SherpaAgentResolution = { ...resolution, agents: selection.agents };
  const filteredTuning: SherpaTuning = {
    ...mergedTuning,
    commands: selection.commands,
    instructions: selection.instructions,
    skills: selection.skills,
  };
  const artifactPlan = planArtifacts(projectDirectory, filteredTuning, settings.language);
  const mcpPlan = planMcpConfig(projectDirectory, globalServerNames, globalConfigDirectory);
  const mcpWrite = mcpPlan.write;
  const omoResult = reconcileSherpaOmoAgents(filteredResolution, { projectDirectory, dryRun: true });
  const localMcpServerNames = new Set(mcpPlan.localServerNames);
  const builtInMcpNames = new Set(mcpPlan.builtInServerNames);
  const messages = [
    ...printSelection(detection, selection),
    ...skillSourceMessages(skillResolution),
    ...printActions(projectDirectory, artifactPlan, mcpWrite, omoResult.changedPaths, dryRun),
    ...globalServerNames
      .filter((name) => builtInMcpNames.has(name) && !localMcpServerNames.has(name))
      .sort()
      .map((name) => `Skipped global MCP server ${name}.`),
    ...globalServerNames
      .filter((name) => localMcpServerNames.has(name))
      .sort()
      .map((name) => `Preserved project MCP server ${name}; project server takes precedence over the global server. Remove project entry manually if intended.`),
  ];

  if (!dryRun) {
    applyArtifactPlan(artifactPlan);
    if (mcpWrite) applyConfigWrite(mcpWrite);
    reconcileSherpaOmoAgents(filteredResolution, { projectDirectory });
    return {
      messages: messages.map((message) => message.startsWith("Will write ")
        ? message.replace(/^Will write /u, "Wrote ")
        : message.startsWith("Will remove ")
          ? message.replace(/^Will remove /u, "Removed ")
          : message.startsWith("Will update ")
            ? message.replace(/^Will update /u, "Updated ")
            : message),
    };
  }
  return { messages };
}
