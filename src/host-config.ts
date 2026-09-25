import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  applyEdits,
  createScanner,
  findNodeAtLocation,
  modify,
  parse,
  parseTree,
  SyntaxKind,
  type Node,
  type ParseError,
} from "jsonc-parser";

const CONFIG_FILENAMES = ["opencode.jsonc", "opencode.json"] as const;
const STATE_FILENAME = ".sherpa-owned.json";
const PENDING_FILENAME = ".sherpa-sync-pending.json";
const LOCK_DIRECTORY = ".sherpa-sync.lock";

const PLUGINS = [
  { name: "oh-my-opencode-slim", selector: "oh-my-opencode-slim@2" },
  { name: "@tarquinen/opencode-dcp", selector: "@tarquinen/opencode-dcp@3" },
] as const;
const PLAYWRIGHT = {
  name: "opencode-playwright",
  selector: "opencode-playwright@git+https://github.com/rozsazoltan/opencode-playwright.git#f06567970c9b10ec845c0b8aa1df816d2e6f7333",
};

type JsonObject = Record<string, unknown>;
interface OwnedStateV1 {
  version: 1;
  plugins: string[];
  agents: Record<string, unknown>;
  commands: Record<string, unknown>;
}
interface OwnedStateV2 {
  version: 2;
  plugins: string[];
}
type OwnedState = OwnedStateV1 | OwnedStateV2;
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

function emptyState(): OwnedStateV2 {
  return { version: 2, plugins: [] };
}

function validateState(value: unknown): OwnedState {
  if (object(value) && Array.isArray(value.plugins) &&
      value.plugins.every((item) => typeof item === "string")) {
    if (value.version === 1 && object(value.agents) && object(value.commands)) {
      return value as unknown as OwnedStateV1;
    }
    if (value.version === 2) return value as unknown as OwnedStateV2;
  }
  throw new Error("Sherpa state file is invalid.");
}

function readState(file: string): OwnedState {
  if (!existsSync(file)) return emptyState();
  if (lstatSync(file).isSymbolicLink()) throw new Error("Sherpa state file must not be a symlink.");
  try {
    return validateState(JSON.parse(readFileSync(file, "utf8")) as unknown);
  } catch {
    throw new Error("Sherpa state file is invalid.");
  }
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

interface DesiredPluginEntry {
  value: unknown;
  sourceIndex?: number;
}

function pluginArrayNode(text: string): Node {
  const root = parseTree(text, [], { allowTrailingComma: true });
  const array = root && findNodeAtLocation(root, ["plugins"]);
  if (!array || array.type !== "array") throw new Error("Host plugins must be a package selector array.");
  return array;
}

function commaBetween(text: string, start: number, end: number): { offset: number; length: number } | undefined {
  const scanner = createScanner(text, false);
  scanner.setPosition(start);
  while (scanner.scan() !== SyntaxKind.EOF) {
    const offset = scanner.getTokenOffset();
    if (offset >= end) return undefined;
    if (scanner.getToken() === SyntaxKind.CommaToken) {
      return { offset, length: scanner.getTokenLength() };
    }
  }
  return undefined;
}

function lineStart(text: string, offset: number): number {
  return text.lastIndexOf("\n", offset - 1) + 1;
}

function leadingIndent(text: string, offset: number): string | undefined {
  const start = lineStart(text, offset);
  const prefix = text.slice(start, offset);
  return /^[\t ]*$/u.test(prefix) ? prefix : undefined;
}

function removePluginAt(text: string, index: number): string {
  const array = pluginArrayNode(text);
  const items = array.children ?? [];
  const item = items[index];
  if (!item) throw new Error("Host plugins changed while applying Sherpa edits.");

  let start = item.offset;
  let end = item.offset + item.length;
  if (items.length > 1 && index < items.length - 1) {
    const next = items[index + 1]!;
    const comma = commaBetween(text, end, next.offset);
    if (!comma) throw new Error("Host plugins array has an invalid separator.");
    end = comma.offset + comma.length;
    start = leadingIndent(text, start) === undefined ? start : lineStart(text, start);
  } else if (items.length > 1) {
    const previous = items[index - 1]!;
    const comma = commaBetween(text, previous.offset + previous.length, start);
    if (!comma) throw new Error("Host plugins array has an invalid separator.");
    start = comma.offset;
  } else {
    const closeOffset = array.offset + array.length - 1;
    const trailingComma = commaBetween(text, end, closeOffset);
    if (trailingComma) end = trailingComma.offset + trailingComma.length;
    if (leadingIndent(text, start) !== undefined) start = lineStart(text, start);
  }

  return applyEdits(text, [{ offset: start, length: end - start, content: "" }]);
}

function appendPlugin(text: string, value: unknown): string {
  const array = pluginArrayNode(text);
  const items = array.children ?? [];
  const closeOffset = array.offset + array.length - 1;
  const valueText = JSON.stringify(value);
  const gapStart = items.length === 0 ? array.offset + 1 : items.at(-1)!.offset + items.at(-1)!.length;
  const gap = text.slice(gapStart, closeOffset);

  if (items.length > 0 && !commaBetween(text, gapStart, closeOffset)) {
    const last = items.at(-1)!;
    text = applyEdits(text, [{ offset: last.offset + last.length, length: 0, content: "," }]);
  }

  const updatedArray = pluginArrayNode(text);
  const updatedCloseOffset = updatedArray.offset + updatedArray.length - 1;
  const multiline = /[\r\n]/u.test(text.slice(updatedArray.offset, updatedCloseOffset));
  if (multiline) {
    const closeLineStart = lineStart(text, updatedCloseOffset);
    const closeIndent = text.slice(closeLineStart, updatedCloseOffset);
    const firstItem = updatedArray.children?.[0];
    const itemIndent = (firstItem && leadingIndent(text, firstItem.offset)) ??
      `${leadingIndent(text, updatedArray.offset) ?? ""}  `;
    if (/^[\t ]*$/u.test(closeIndent) && closeLineStart > updatedArray.offset) {
      return applyEdits(text, [{
        offset: closeLineStart,
        length: 0,
        content: `${itemIndent}${valueText}${text.includes("\r\n") ? "\r\n" : "\n"}`,
      }]);
    }
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const fallbackIndent = itemIndent;
    return applyEdits(text, [{
      offset: updatedCloseOffset,
      length: 0,
      content: `${eol}${fallbackIndent}${valueText}`,
    }]);
  }

  const needsSpace = gap.length === 0 || !/[\t ]$/u.test(gap);
  return applyEdits(text, [{
    offset: updatedCloseOffset,
    length: 0,
    content: `${needsSpace ? " " : ""}${valueText}`,
  }]);
}

function applyPluginEntries(text: string, sourceEntries: unknown[], desiredEntries: DesiredPluginEntry[]): string {
  const retained = new Set(desiredEntries.flatMap((entry) =>
    entry.sourceIndex === undefined ? [] : [entry.sourceIndex]));

  for (const entry of desiredEntries) {
    if (entry.sourceIndex !== undefined && !same(sourceEntries[entry.sourceIndex], entry.value)) {
      text = apply(text, ["plugins", entry.sourceIndex], entry.value);
    }
  }

  const removed = sourceEntries.map((_, index) => index).filter((index) => !retained.has(index)).reverse();
  for (const index of removed) text = removePluginAt(text, index);
  for (const entry of desiredEntries) {
    if (entry.sourceIndex === undefined) text = appendPlugin(text, entry.value);
  }
  return text;
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
  let pending: PendingSync | undefined;
  if (object(value) && value.version === 1 && typeof value.beforeConfig === "string" &&
      typeof value.afterConfig === "string" && typeof value.afterState === "string" &&
      (value.beforeState === null || typeof value.beforeState === "string")) {
    try {
      const nextState = validateState(value.nextState);
      if (digest(stateText(nextState)) === value.afterState) {
        pending = { ...value, nextState } as unknown as PendingSync;
      }
    } catch {
      // Invalid state payloads make the entire recovery journal unsafe to apply.
    }
  }
  if (!pending) throw new Error("Sherpa pending journal is invalid; host config was not modified.");
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
  const next = emptyState();

  // Version 1 tracked Sherpa-installed host agents and commands. Retire only
  // definitions that still exactly match that ownership record.
  if (state.version === 1) {
    for (const section of ["agents", "commands"] as const) {
      if (current[section] !== undefined && !object(current[section])) {
        throw new Error(`Host ${section} must be an object.`);
      }
      for (const [name, previous] of Object.entries(state[section])) {
        current = parse(text) as JsonObject;
        const definitions = current[section];
        if (object(definitions) && Object.hasOwn(definitions, name) && same(definitions[name], previous)) {
          text = apply(text, [section, name], undefined);
        }
      }
    }
    current = parse(text) as JsonObject;
  }

  const desiredPlugins = enablePlaywright ? [...PLUGINS, PLAYWRIGHT] : [...PLUGINS];
  if (current.plugins !== undefined && (!Array.isArray(current.plugins) ||
      current.plugins.some((entry) => packageOf(entry) === undefined))) {
    throw new Error("Host plugins must be a package selector array.");
  }
  const pluginEntries = (current.plugins ?? []) as unknown[];
  const desiredEntries: DesiredPluginEntry[] = pluginEntries
    .map((value, sourceIndex) => ({ value, sourceIndex }))
    .filter(({ value }) => typeof value !== "string" || !state.plugins.includes(value) ||
      desiredPlugins.some((plugin) => matchesPackage(value, plugin.name)));
  for (const plugin of desiredPlugins) {
    const matchingIndices = desiredEntries.flatMap((entry, index) =>
      matchesPackage(packageOf(entry.value) ?? "", plugin.name) ? [index] : []);
    const ownedIndices = matchingIndices.filter((index) => typeof desiredEntries[index]!.value === "string" &&
      state.plugins.includes(desiredEntries[index]!.value as string));
    const userIndices = matchingIndices.filter((index) => !ownedIndices.includes(index));

    if (userIndices.length > 0) {
      // A user selector takes precedence; remove only exact unchanged Sherpa entries.
      for (const index of ownedIndices.reverse()) desiredEntries.splice(index, 1);
    } else if (ownedIndices.length > 0) {
      const keepIndex = ownedIndices.find((index) => desiredEntries[index]!.value === plugin.selector) ?? ownedIndices[0]!;
      desiredEntries[keepIndex]!.value = plugin.selector;
      for (const index of ownedIndices.reverse()) {
        if (index !== keepIndex) desiredEntries.splice(index, 1);
      }
      next.plugins.push(plugin.selector);
    } else if (matchingIndices.length === 0) {
      desiredEntries.push({ value: plugin.selector });
      next.plugins.push(plugin.selector);
    }
  }

  if (current.plugins === undefined) {
    text = apply(text, ["plugins"], desiredEntries.map((entry) => entry.value));
  } else if (!same(pluginEntries, desiredEntries.map((entry) => entry.value))) {
    text = applyPluginEntries(text, pluginEntries, desiredEntries);
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
