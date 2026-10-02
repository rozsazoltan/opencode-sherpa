import type { SherpaOmoAgent } from "./agent-sources.ts";
import {
  PROJECT_AGENT_CATALOG,
  PROJECT_COMMAND_CATALOG,
  PROJECT_INSTRUCTION_CATALOG,
  PROJECT_SKILL_CATALOG,
  type ProjectContentRule,
  type ProjectStack,
} from "./project-catalog.ts";
import type { PackagedCommand, PackagedInstruction, PackagedSkill, SherpaTuning } from "./tuning.ts";

export interface ConfiguredContentSelection {
  readonly auto: boolean;
  readonly include: string[];
  readonly exclude: string[];
}

export interface ProjectDetection {
  readonly stacks: readonly ProjectStack[];
  readonly features: readonly string[];
}

export interface ProjectContentReason {
  readonly kind: "agent" | "command" | "instruction" | "skill";
  readonly id: string;
  readonly reason: string;
}

export interface ProjectContentSelection {
  readonly agents: SherpaOmoAgent[];
  readonly commands: PackagedCommand[];
  readonly instructions: PackagedInstruction[];
  readonly skills: PackagedSkill[];
  readonly reasons: ProjectContentReason[];
}

export interface ProjectContentSelectionOptions {
  readonly agents?: unknown;
  readonly commands?: unknown;
  readonly instructions?: unknown;
  readonly skills?: unknown;
}

const CONTENT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/u;
const CONFIG_KEYS = new Set(["auto", "include", "exclude"]);
const OPTION_KEYS = new Set(["agents", "commands", "instructions", "skills"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function lexicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function readIdList(value: unknown, key: "include" | "exclude"): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`Content selection '${key}' must be an array of IDs.`);
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const id of value) {
    if (typeof id !== "string" || !CONTENT_ID.test(id)) {
      throw new TypeError(`Content selection '${key}' must contain valid content IDs.`);
    }
    if (seen.has(id)) throw new TypeError(`Content selection '${key}' contains duplicate ID '${id}'.`);
    seen.add(id);
    ids.push(id);
  }
  return ids.sort(lexicalCompare);
}

export function configuredContentSelection(value: unknown): ConfiguredContentSelection {
  if (value === undefined) return { auto: true, include: [], exclude: [] };
  if (!isRecord(value)) throw new TypeError("Content selection must be an object.");
  const unsupported = Object.keys(value).find((key) => !CONFIG_KEYS.has(key));
  if (unsupported) throw new TypeError(`Unsupported content selection field '${unsupported}'.`);
  if (value.auto !== undefined && typeof value.auto !== "boolean") {
    throw new TypeError("Content selection 'auto' must be a boolean.");
  }
  return {
    auto: value.auto === undefined ? true : value.auto,
    include: readIdList(value.include, "include"),
    exclude: readIdList(value.exclude, "exclude"),
  };
}

function validateOptions(value: unknown): ProjectContentSelectionOptions {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new TypeError("Project content selection options must be an object.");
  const unsupported = Object.keys(value).find((key) => !OPTION_KEYS.has(key));
  if (unsupported) throw new TypeError(`Unsupported project content selection option '${unsupported}'.`);
  return value;
}

function basename(sourcePath: string): string {
  const normalized = sourcePath.replaceAll("\\", "/");
  return (normalized.slice(normalized.lastIndexOf("/") + 1).replace(/\.md$/iu, "")).toLowerCase();
}

function matchingReasons(rule: ProjectContentRule, detection: ProjectDetection): string[] {
  if (rule.always) return ["Common project guidance."];
  const stacks = new Set(detection.stacks);
  const features = new Set(detection.features);
  const reasons: string[] = [];
  for (const stack of rule.stacks ?? []) {
    if (stacks.has(stack)) reasons.push(`Matched detected ${stack} stack.`);
  }
  for (const feature of rule.features ?? []) {
    if (features.has(feature)) reasons.push(`Matched detected ${feature} feature.`);
  }
  return reasons;
}

function skillMatchingReasons(id: string, detection: ProjectDetection): string[] {
  const rule = PROJECT_SKILL_CATALOG.find((candidate) => candidate.id === id);
  return rule ? matchingReasons(rule, detection) : [];
}

type ContentKind = ProjectContentReason["kind"];

function validateKnownIds(kind: ContentKind, ids: readonly string[], known: ReadonlySet<string>): void {
  for (const id of ids) {
    if (!known.has(id)) throw new TypeError(`Unknown ${kind} ID '${id}' in content selection.`);
  }
}

function assertUniqueIds(kind: ContentKind, ids: readonly string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new TypeError(`Duplicate ${kind} ID '${id}' was discovered.`);
    seen.add(id);
  }
}

function selectItems<T>(
  kind: ContentKind,
  items: readonly T[],
  idOf: (item: T) => string,
  configuration: ConfiguredContentSelection,
  matching: (item: T) => string[],
): { items: T[]; reasons: ProjectContentReason[] } {
  const ids = items.map(idOf);
  assertUniqueIds(kind, ids);
  const available = new Set(ids);
  validateKnownIds(kind, configuration.include, available);
  validateKnownIds(kind, configuration.exclude, available);

  const included = new Set(configuration.include);
  const excluded = new Set(configuration.exclude);
  const selected: T[] = [];
  const reasons: ProjectContentReason[] = [];
  for (const item of items) {
    const id = idOf(item);
    if (excluded.has(id)) continue;
    const matches = configuration.auto ? matching(item) : [];
    const explicitlyIncluded = included.has(id);
    if (matches.length === 0 && !explicitlyIncluded) continue;
    selected.push(item);
    reasons.push({
      kind,
      id,
      reason: [
        ...matches,
        ...(explicitlyIncluded ? ["Explicitly included."] : []),
      ].join(" "),
    });
  }
  return { items: selected, reasons };
}

export function selectProjectContent(
  detection: ProjectDetection,
  agents: readonly SherpaOmoAgent[],
  tuning: SherpaTuning,
  options?: ProjectContentSelectionOptions,
): ProjectContentSelection {
  const configured = validateOptions(options);
  const agentSelection = configuredContentSelection(configured.agents);
  const commandSelection = configuredContentSelection(configured.commands);
  const instructionSelection = configuredContentSelection(configured.instructions);
  const skillSelection = configuredContentSelection(configured.skills);
  const agentRules = new Map<string, ProjectContentRule>(
    PROJECT_AGENT_CATALOG.map((rule) => [rule.id, rule] as const),
  );
  const commandRules = new Map<string, ProjectContentRule>(
    PROJECT_COMMAND_CATALOG.map((rule) => [rule.id, rule] as const),
  );
  const instructionRules = new Map<string, ProjectContentRule>(
    PROJECT_INSTRUCTION_CATALOG.map((rule) => [rule.id, rule] as const),
  );

  const selectedAgents = selectItems("agent", agents, ({ id }) => id, agentSelection, (agent) => {
    const rule = agentRules.get(basename(agent.sourcePath));
    return rule ? matchingReasons(rule, detection) : [];
  });
  const selectedCommands = selectItems("command", tuning.commands, ({ name }) => name, commandSelection, (command) => {
    const rule = commandRules.get(command.name);
    return rule ? matchingReasons(rule, detection) : [];
  });
  const selectedInstructions = selectItems("instruction", tuning.instructions, ({ id }) => id, instructionSelection, (instruction) => {
    const rule = instructionRules.get(instruction.id);
    return rule ? matchingReasons(rule, detection) : [];
  });
  const selectedSkills = selectItems("skill", tuning.skills, ({ id }) => id, skillSelection, (skill) =>
    skillMatchingReasons(skill.id, detection));

  return {
    agents: selectedAgents.items.sort((left, right) => lexicalCompare(left.id, right.id)),
    commands: selectedCommands.items.sort((left, right) => lexicalCompare(left.name, right.name)),
    instructions: selectedInstructions.items.sort((left, right) => lexicalCompare(left.id, right.id)),
    skills: selectedSkills.items.sort((left, right) => lexicalCompare(left.id, right.id)),
    reasons: [
      ...selectedAgents.reasons,
      ...selectedCommands.reasons,
      ...selectedInstructions.reasons,
      ...selectedSkills.reasons,
    ].sort((left, right) =>
      lexicalCompare(left.kind, right.kind) || lexicalCompare(left.id, right.id) || lexicalCompare(left.reason, right.reason)),
  };
}

/** Select skill IDs from available sources using configured `skills` selection. */
export function selectProjectSkillIds(
  detection: ProjectDetection,
  availableIds: readonly string[],
  options?: unknown,
): string[] {
  const selection = configuredContentSelection(options);
  return selectItems(
    "skill",
    availableIds,
    (id) => id,
    selection,
    (id) => skillMatchingReasons(id, detection),
  ).items.sort(lexicalCompare);
}
