import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { Registration } from "@opencode/plugin/promise/registration";
import type { SessionHooks } from "@opencode/plugin/promise/session";

const REQUIRED_MODES = [
  "off",
  "lite",
  "full",
  "ultra",
  "wenyan-lite",
  "wenyan",
  "wenyan-full",
  "wenyan-ultra",
  "commit",
  "review",
  "compress",
] as const;
const REQUIRED_INDEPENDENT_MODES = ["commit", "review", "compress"] as const;
const INJECTION_MARKER = "<!-- opencode-sherpa:caveman-mode -->";
const MODE_METADATA_KEY = "opencode-sherpa:caveman-mode";

interface PayloadFiles {
  root: string;
  pluginDirectory: string;
  configFile: string;
  parserFile: string;
  skillFile: string;
  agentsFile: string;
}

interface CavemanConfig {
  VALID_MODES: string[];
  loadFilteredRuleset: (mode: string, pluginBase: string) => unknown;
}

interface ModeParser {
  INDEPENDENT_MODES: Set<string>;
  parseModeChange: (
    prompt: string,
    options: { getDefaultMode: () => string; expandedTpl: true; unwrapQuotes: true },
  ) => unknown;
}

interface ModeChangeSet {
  action: "set";
  mode: string;
}

interface ModeChangeClear {
  action: "clear";
}

interface ModeChangeUnresolved {
  action: "unresolved";
}

type ModeChange = ModeChangeSet | ModeChangeClear | ModeChangeUnresolved;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function requiredPath(root: string, segments: readonly string[], kind: "directory" | "file"): string {
  let current = root;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!segment || segment === "." || segment === ".." || path.isAbsolute(segment)) {
      throw new Error("Caveman runtime payload contains an invalid path.");
    }
    current = path.join(current, segment);

    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      throw new Error(`Caveman runtime payload is missing a required ${kind}.`);
    }
    if (stat.isSymbolicLink()) throw new Error("Caveman runtime payload paths must not be symlinks.");

    const isFinal = index === segments.length - 1;
    if (!isFinal || kind === "directory") {
      if (!stat.isDirectory()) throw new Error("Caveman runtime payload has an invalid directory path.");
    } else if (!stat.isFile()) {
      throw new Error("Caveman runtime payload has an invalid file path.");
    }

    let resolved: string;
    try {
      resolved = realpathSync(current);
    } catch {
      throw new Error("Caveman runtime payload path could not be resolved.");
    }
    if (!isWithin(root, resolved)) throw new Error("Caveman runtime payload path escapes its installed root.");
  }

  return current;
}

function validatePayload(installedRoot: string): PayloadFiles {
  if (!path.isAbsolute(installedRoot)) {
    throw new TypeError("Caveman runtime installedRoot must be an absolute path.");
  }

  const requestedRoot = path.resolve(installedRoot);
  let rootStat;
  try {
    rootStat = lstatSync(requestedRoot);
  } catch {
    throw new Error("Caveman runtime installedRoot does not exist.");
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("Caveman runtime installedRoot must be a real directory.");
  }

  let root: string;
  try {
    root = realpathSync(requestedRoot);
  } catch {
    throw new Error("Caveman runtime installedRoot could not be resolved.");
  }

  const pluginDirectory = requiredPath(root, ["plugins", "caveman"], "directory");
  const configFile = requiredPath(root, ["plugins", "caveman", "caveman-config.cjs"], "file");
  const parserFile = requiredPath(root, ["plugins", "caveman", "caveman-parse.cjs"], "file");
  const skillFile = requiredPath(root, ["skills", "caveman", "SKILL.md"], "file");
  const agentsFile = requiredPath(root, ["AGENTS.md"], "file");

  try {
    lstatSync(path.join(pluginDirectory, "caveman-config.js"));
    throw new Error("Caveman runtime payload has a shadowing config file.");
  } catch (error) {
    if (!isRecord(error) || error.code !== "ENOENT") throw error;
  }

  return { root, pluginDirectory, configFile, parserFile, skillFile, agentsFile };
}

function evaluateCommonJs(filePath: string, isolateClaudeRoot = false): unknown {
  const source = readFileSync(filePath, "utf8").replace(/^#![^\n]*\n/u, "");
  const moduleRecord: { exports: unknown } = { exports: {} };
  const scopedRequire = createRequire(pathToFileURL(filePath));
  const scopedProcess = Object.create(process) as NodeJS.Process;
  if (isolateClaudeRoot) {
    Object.defineProperty(scopedProcess, "env", {
      value: { ...process.env, CLAUDE_PLUGIN_ROOT: "" },
    });
  }
  new Function("module", "exports", "require", "__dirname", "__filename", "process", source)(
    moduleRecord,
    moduleRecord.exports,
    scopedRequire,
    path.dirname(filePath),
    filePath,
    scopedProcess,
  );
  return moduleRecord.exports;
}

function isCavemanConfig(value: unknown): value is CavemanConfig {
  if (!isRecord(value) || !Array.isArray(value.VALID_MODES) || typeof value.loadFilteredRuleset !== "function") {
    return false;
  }
  return value.VALID_MODES.every((mode) => typeof mode === "string");
}

function isModeParser(value: unknown): value is ModeParser {
  if (!isRecord(value) || typeof value.parseModeChange !== "function" || !(value.INDEPENDENT_MODES instanceof Set)) {
    return false;
  }
  return [...value.INDEPENDENT_MODES].every((mode) => typeof mode === "string");
}

function loadRuntime(installedRoot: string): {
  payload: PayloadFiles;
  config: CavemanConfig;
  parser: ModeParser;
  validModes: Set<string>;
  independentModes: Set<string>;
  agentsRules: string;
} {
  const payload = validatePayload(installedRoot);
  const configExport = evaluateCommonJs(payload.configFile, true);
  const parserExport = evaluateCommonJs(payload.parserFile);
  if (!isCavemanConfig(configExport)) throw new Error("Pinned Caveman config has invalid required exports.");
  if (!isModeParser(parserExport)) throw new Error("Pinned Caveman parser has invalid required exports.");

  const validModes = new Set(configExport.VALID_MODES);
  const independentModes = parserExport.INDEPENDENT_MODES;
  if (REQUIRED_MODES.some((mode) => !validModes.has(mode)) ||
      REQUIRED_INDEPENDENT_MODES.some((mode) => !independentModes.has(mode))) {
    throw new Error("Pinned Caveman config or parser is missing required modes.");
  }

  const skill = readFileSync(payload.skillFile, "utf8");
  const agentsRules = readFileSync(payload.agentsFile, "utf8");
  if (!skill.trim() || !agentsRules.trim()) throw new Error("Caveman runtime payload contains an empty rules file.");

  return { payload, config: configExport, parser: parserExport, validModes, independentModes, agentsRules };
}

function parseChange(value: unknown): ModeChange | null {
  if (!isRecord(value)) return null;
  if (value.action === "clear") return { action: "clear" };
  if (value.action === "unresolved") return { action: "unresolved" };
  if (value.action === "set" && typeof value.mode === "string") {
    return { action: "set", mode: value.mode };
  }
  return null;
}

function removeInjectedRules(system: SessionHooks["context"]["system"]): void {
  for (let index = system.length - 1; index >= 0; index -= 1) {
    const part = system[index];
    if (part?.type === "text" && part.text.includes(INJECTION_MARKER)) system.splice(index, 1);
  }
}

async function disposeRegistrations(registrations: readonly Registration[], suppressErrors: boolean): Promise<void> {
  let firstError: unknown;
  let hasError = false;
  for (const registration of [...registrations].reverse()) {
    try {
      await registration.dispose();
    } catch (error) {
      if (!hasError) {
        firstError = error;
        hasError = true;
      }
    }
  }
  if (hasError && !suppressErrors) throw firstError;
}

export async function registerCavemanMode(
  ctx: Pick<Context, "session">,
  installedRoot: string,
): Promise<Registration> {
  const { payload, config, parser, validModes, independentModes, agentsRules } = loadRuntime(installedRoot);
  const modes = new Map<string, string>();
  const registrations: Registration[] = [];

  try {
    registrations.push(await ctx.session.hook("prompt", (input) => {
      if (typeof input.sessionID !== "string" || !input.sessionID || typeof input.prompt.text !== "string") return;

      let change: ModeChange | null;
      try {
        change = parseChange(parser.parseModeChange(input.prompt.text, {
          // The parser calls this only for activation; never consult config.getDefaultMode(), which reads Claude config.
          getDefaultMode: () => "full",
          expandedTpl: true,
          unwrapQuotes: true,
        }));
      } catch {
        change = null;
      }

      if (change?.action === "clear") {
        modes.delete(input.sessionID);
      } else if (change?.action === "set" && change.mode !== "off" &&
          validModes.has(change.mode) && !independentModes.has(change.mode)) {
        modes.set(input.sessionID, change.mode);
      }

      // Prompt hooks run before queue admission. Snapshot this prompt's mode so a
      // later queued mode change cannot alter an earlier turn's retry context.
      input.metadata = { ...input.metadata, [MODE_METADATA_KEY]: modes.get(input.sessionID) ?? "off" };
    }));

    registrations.push(await ctx.session.hook("context", (input) => {
      removeInjectedRules(input.system);
      if (typeof input.sessionID !== "string" || !input.sessionID) return;

      const activePrompt = [...input.messages].reverse().find((message) => {
        if (message.role !== "user" || !isRecord(message.metadata)) return false;
        const value = message.metadata[MODE_METADATA_KEY];
        return value === "off" || (typeof value === "string" && validModes.has(value) && !independentModes.has(value));
      });
      if (!activePrompt || !isRecord(activePrompt.metadata)) return;
      const mode = activePrompt.metadata[MODE_METADATA_KEY];
      if (typeof mode !== "string" || mode === "off") return;

      let filteredRules: unknown;
      try {
        requiredPath(payload.root, ["skills", "caveman", "SKILL.md"], "file");
        filteredRules = config.loadFilteredRuleset(mode, payload.pluginDirectory);
      } catch {
        return;
      }
      if (typeof filteredRules !== "string" || !filteredRules.trim()) return;

      input.system.push({
        type: "text",
        text: `${INJECTION_MARKER}\n${agentsRules.trim()}\n\n${filteredRules.trim()}`,
      });
    }));
  } catch (error) {
    modes.clear();
    await disposeRegistrations(registrations, true);
    throw error;
  }

  return {
    dispose: async () => {
      modes.clear();
      await disposeRegistrations(registrations, false);
    },
  };
}
