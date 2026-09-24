import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";

const CONFIG_FILENAMES = ["opencode.jsonc", "opencode.json"] as const;
const STATE_FILENAME = ".sherpa-owned.json";
const PENDING_FILENAME = ".sherpa-sync-pending.json";
const LOCK_DIRECTORY = ".sherpa-sync.lock";
const CAVEMAN_ROOT = fileURLToPath(new URL(".", import.meta.resolve("caveman-installer/package.json")));

const PLUGINS = [
  { name: "oh-my-opencode-slim", selector: "oh-my-opencode-slim@2" },
  { name: "@tarquinen/opencode-dcp", selector: "@tarquinen/opencode-dcp@3" },
] as const;
const PLAYWRIGHT = {
  name: "opencode-playwright",
  selector: "opencode-playwright@git+https://github.com/rozsazoltan/opencode-playwright.git#f06567970c9b10ec845c0b8aa1df816d2e6f7333",
};
const AGENT_NAMES = ["cavecrew-investigator", "cavecrew-builder", "cavecrew-reviewer"] as const;
const COMMANDS: Record<string, { description: string; template: string }> = {
  caveman: {
    description: "Switch Caveman mode for this session",
    template: "Apply the caveman skill with level '$ARGUMENTS' (default full, off disables it).",
  },
  "caveman-commit": {
    description: "Draft a concise Conventional Commit message",
    template: "Use the caveman-commit skill for this request: $ARGUMENTS",
  },
  "caveman-review": {
    description: "Review changes in concise Caveman format",
    template: "Use the caveman-review skill to review: $ARGUMENTS",
  },
  "caveman-help": {
    description: "Show the Caveman quick reference",
    template: "Use the caveman-help skill to show the OpenCode Caveman reference.",
  },
  "caveman-stats": {
    description: "Report available session usage without guessed savings",
    template: "Use the caveman-stats skill. Report only measured OpenCode session usage, if available.",
  },
  "caveman-compress": {
    description: "Compress prose in a natural-language file",
    template: "Use the caveman-compress skill for this file: $ARGUMENTS. Confirm a safe backup before editing.",
  },
};

type JsonObject = Record<string, unknown>;
interface OwnedState {
  version: 1;
  plugins: string[];
  agents: Record<string, unknown>;
  commands: Record<string, unknown>;
}
interface PendingSync {
  version: 1;
  beforeConfig: string;
  afterConfig: string;
  beforeState: string | null;
  afterState: string;
  nextState: OwnedState;
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function stateText(state: OwnedState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

function optionalDigest(file: string): string | null {
  if (!existsSync(file)) return null;
  if (lstatSync(file).isSymbolicLink()) throw new Error("Sherpa state file must not be a symlink.");
  return digest(readFileSync(file, "utf8"));
}

function object(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyState(): OwnedState {
  return { version: 1, plugins: [], agents: {}, commands: {} };
}

function readState(file: string): OwnedState {
  if (!existsSync(file)) return emptyState();
  if (lstatSync(file).isSymbolicLink()) throw new Error("Sherpa state file must not be a symlink.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error("Sherpa state file is invalid.");
  }
  if (!object(parsed) || parsed.version !== 1 || !Array.isArray(parsed.plugins) ||
      !parsed.plugins.every((item) => typeof item === "string") ||
      !object(parsed.agents) || !object(parsed.commands)) {
    throw new Error("Sherpa state file is invalid.");
  }
  return parsed as unknown as OwnedState;
}

function agentDefinition(name: string): JsonObject {
  const document = readFileSync(path.join(CAVEMAN_ROOT, "agents", `${name}.md`), "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(document);
  if (!match?.[1]?.includes(`name: ${name}`) || match[2] === undefined) {
    throw new Error(`Pinned Caveman agent ${name} has invalid frontmatter.`);
  }
  const description = /^description: >\r?\n((?:[ \t]+.*\r?\n)+)/mu.exec(match[1]);
  if (!description?.[1]) throw new Error(`Pinned Caveman agent ${name} has no description.`);
  let system: string = match[2];
  if (name === "cavecrew-reviewer") {
    const original = "`Bash` only for `git diff`/`git log -p`/`git show`. No mutating commands.";
    if (!system.includes(original)) throw new Error("Pinned Caveman reviewer instructions have changed.");
    system = system.replace(original,
      "Shell is unavailable. Review only the diff or file excerpts supplied by the parent prompt. If missing, request that material; never claim to have inspected Git state.");
  }
  if (name === "cavecrew-investigator") {
    const original = "`Bash` for `git log -S`/`git grep`/`find` when faster.";
    if (!system.includes(original)) throw new Error("Pinned Caveman investigator instructions have changed.");
    system = system.replace(original, "Shell is unavailable; use only read-only search and file tools.");
  }
  const result: JsonObject = {
    description: description[1].trim().replace(/\s+/gu, " "),
    mode: "subagent",
    system,
  };
  if (name !== "cavecrew-builder") {
    result.permissions = [
      { action: "edit", resource: "*", effect: "deny" },
      { action: "shell", resource: "*", effect: "deny" },
    ];
  } else {
    result.permissions = [{ action: "shell", resource: "*", effect: "deny" }];
  }
  return result;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function packageOf(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry;
  return object(entry) && typeof entry.package === "string" ? entry.package : undefined;
}

function matchesPackage(selector: string, name: string): boolean {
  return selector === name || selector.startsWith(`${name}@`);
}

function apply(text: string, keys: (string | number)[], value: unknown): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  return applyEdits(text, modify(text, keys, value, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol },
  }));
}

function writeAtomic(file: string, value: string, mode: number): void {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, value, { flag: "wx", mode });
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

function configDirectory(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), ".config"), "opencode");
}

async function acquireLock(directory: string): Promise<() => void> {
  const lock = path.join(directory, LOCK_DIRECTORY);
  const deadline = performance.now() + 5_000;
  while (true) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      return () => rmdirSync(lock);
    } catch (error) {
      if (!object(error) || error.code !== "EEXIST") throw error;
      if (performance.now() >= deadline) {
        throw new Error("Sherpa host sync is locked; verify no other sync is running before removing a stale lock.");
      }
      await delay(50);
    }
  }
}

function recoverPending(directory: string, configFile: string, stateFile: string): void {
  const file = path.join(directory, PENDING_FILENAME);
  if (!existsSync(file)) return;
  if (lstatSync(file).isSymbolicLink()) throw new Error("Sherpa pending journal must not be a symlink.");
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error("Sherpa pending journal is invalid; host config was not modified.");
  }
  if (!object(value) || value.version !== 1 || typeof value.beforeConfig !== "string" ||
      typeof value.afterConfig !== "string" || typeof value.afterState !== "string" ||
      (value.beforeState !== null && typeof value.beforeState !== "string") ||
      !object(value.nextState) || digest(stateText(value.nextState as unknown as OwnedState)) !== value.afterState) {
    throw new Error("Sherpa pending journal is invalid; host config was not modified.");
  }
  const pending = value as unknown as PendingSync;
  const configHash = digest(readFileSync(configFile, "utf8"));
  const journalHash = optionalDigest(stateFile);
  if (configHash === pending.afterConfig && journalHash === pending.beforeState) {
    writeAtomic(stateFile, stateText(pending.nextState), 0o600);
  } else if (configHash === pending.beforeConfig && journalHash === pending.beforeState) {
    // A crash occurred before replacing either file; retry from the original state.
  } else if (configHash !== pending.afterConfig || journalHash !== pending.afterState) {
    throw new Error("Sherpa sync was interrupted and host files changed; manual recovery is required.");
  }
  rmSync(file);
}

/** Reconcile only Sherpa-owned global host entries; never rewrite a user-edited entry. */
export async function syncHostConfig(directory = configDirectory(), enablePlaywright =
  process.platform === "win32" || Boolean(process.env.WSL_DISTRO_NAME)): Promise<boolean> {
  const unlock = await acquireLock(directory);
  try {
    return performSync(directory, enablePlaywright);
  } finally {
    unlock();
  }
}

function performSync(directory: string, enablePlaywright: boolean): boolean {
  const found = CONFIG_FILENAMES.map((filename) => path.join(directory, filename)).filter(existsSync);
  if (found.length !== 1) {
    throw new Error("Host sync requires exactly one existing global opencode.json(c) file.");
  }
  const file = found[0]!;
  if (lstatSync(file).isSymbolicLink()) throw new Error("Host config must not be a symlink.");
  const stateFile = path.join(directory, STATE_FILENAME);
  recoverPending(directory, file, stateFile);
  const original = readFileSync(file, "utf8");
  const errors: ParseError[] = [];
  let text = original;
  const parsed = parse(text, errors, { allowTrailingComma: true }) as unknown;
  if (errors.length || !object(parsed)) throw new Error("Host config is not a valid JSONC object.");
  let current: JsonObject = parsed;
  const state = readState(stateFile);
  const next: OwnedState = emptyState();

  const desiredPlugins = enablePlaywright ? [...PLUGINS, PLAYWRIGHT] : [...PLUGINS];
  if (current.plugins !== undefined && (!Array.isArray(current.plugins) ||
      current.plugins.some((entry) => packageOf(entry) === undefined))) {
    throw new Error("Host plugins must be a package selector array.");
  }
  const pluginEntries = (current.plugins ?? []) as unknown[];
  for (let index = pluginEntries.length - 1; index >= 0; index--) {
    const selector = packageOf(pluginEntries[index]);
    if (selector && typeof pluginEntries[index] === "string" &&
        state.plugins.includes(selector) &&
        !desiredPlugins.some((plugin) => matchesPackage(selector, plugin.name))) {
      text = apply(text, ["plugins", index], undefined);
    }
  }
  for (const plugin of desiredPlugins) {
    current = parse(text) as JsonObject;
    const entries = (current.plugins ?? []) as unknown[];
    const foundIndex = entries.findIndex((entry) => matchesPackage(packageOf(entry) ?? "", plugin.name));
    if (foundIndex < 0) {
      text = current.plugins === undefined
        ? apply(text, ["plugins"], [plugin.selector])
        : apply(text, ["plugins", entries.length], plugin.selector);
      next.plugins.push(plugin.selector);
    } else if (state.plugins.includes(packageOf(entries[foundIndex])!) &&
               same(entries[foundIndex], packageOf(entries[foundIndex]))) {
      if (entries[foundIndex] !== plugin.selector) text = apply(text, ["plugins", foundIndex], plugin.selector);
      next.plugins.push(plugin.selector);
    }
  }

  for (const [section, desired] of [
    ["agents", Object.fromEntries(AGENT_NAMES.map((name) => [name, agentDefinition(name)]))],
    ["commands", COMMANDS],
  ] as const) {
    current = parse(text) as JsonObject;
    if (current[section] !== undefined && !object(current[section])) {
      throw new Error(`Host ${section} must be an object.`);
    }
    for (const [name, previous] of Object.entries(state[section])) {
      if (Object.hasOwn(desired, name)) continue;
      current = parse(text) as JsonObject;
      if (same((current[section] as JsonObject | undefined)?.[name], previous)) {
        text = apply(text, [section, name], undefined);
      }
    }
    for (const [name, definition] of Object.entries(desired)) {
      current = parse(text) as JsonObject;
      const existing = (current[section] as JsonObject | undefined)?.[name];
      if (existing === undefined || (Object.hasOwn(state[section], name) && same(existing, state[section][name]))) {
        if (!same(existing, definition)) text = apply(text, [section, name], definition);
        next[section][name] = definition;
      }
    }
  }

  if (text === original && same(next, state)) return false;
  // Recheck before replacement to avoid clobbering a straightforward concurrent edit.
  if (readFileSync(file, "utf8") !== original) throw new Error("Host config changed during Sherpa sync.");
  const beforeState = optionalDigest(stateFile);
  const pending: PendingSync = {
    version: 1,
    beforeConfig: digest(original),
    afterConfig: digest(text),
    beforeState,
    afterState: digest(stateText(next)),
    nextState: next,
  };
  const pendingFile = path.join(directory, PENDING_FILENAME);
  if (existsSync(pendingFile)) throw new Error("Sherpa pending journal already exists.");
  writeAtomic(pendingFile, `${JSON.stringify(pending, null, 2)}\n`, 0o600);
  if (text !== original) writeAtomic(file, text, lstatSync(file).mode & 0o777);
  if (!same(next, state)) writeAtomic(stateFile, stateText(next), 0o600);
  rmSync(pendingFile);
  return text !== original;
}
