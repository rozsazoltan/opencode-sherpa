import os from "node:os";
import path from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import { inspectPath, isRecord, readTextFile } from "./agent-files.ts";

const GLOBAL_CONFIG_FILES = ["opencode.jsonc", "opencode.json"] as const;

export function defaultOpenCodeConfigDirectory(options: {
  readonly homeDirectory?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
} = {}): string {
  const env = options.env ?? process.env;
  const xdgConfigHome = env.XDG_CONFIG_HOME;
  const configHome = xdgConfigHome && path.isAbsolute(xdgConfigHome)
    ? xdgConfigHome
    : path.join(options.homeDirectory ?? os.homedir(), ".config");
  return path.resolve(configHome, "opencode");
}

export function readGlobalMcpServerNames(configDirectory: string): readonly string[] {
  if (!path.isAbsolute(configDirectory)) {
    throw new Error("Global OpenCode config directory must be an absolute path.");
  }

  const directoryStat = inspectPath(configDirectory);
  if (!directoryStat) return [];
  if (!directoryStat.isDirectory()) {
    throw new Error(`Global OpenCode config directory must be a directory: ${configDirectory}`);
  }

  const existing = GLOBAL_CONFIG_FILES
    .map((name) => path.join(configDirectory, name))
    .filter((file) => inspectPath(file) !== undefined);
  if (existing.length > 1) {
    throw new Error(`Multiple global OpenCode config files exist: ${existing.join(", ")}`);
  }
  const file = existing[0];
  if (!file) return [];
  if (!inspectPath(file)?.isFile()) {
    throw new Error(`Global OpenCode config must be a regular file: ${file}`);
  }

  let source: string | undefined;
  try {
    source = readTextFile(file);
  } catch {
    throw new Error(`Unable to read global OpenCode config: ${file}`);
  }
  if (source === undefined) return [];

  const errors: ParseError[] = [];
  const parsed: unknown = parse(source, errors, { allowTrailingComma: true });
  if (errors.length > 0) throw new Error(`Global OpenCode config is malformed: ${file}`);
  if (!isRecord(parsed)) throw new Error(`Global OpenCode config must contain an object: ${file}`);
  if (parsed.mcp === undefined) return [];
  if (!isRecord(parsed.mcp)) throw new Error(`Global OpenCode config 'mcp' must be an object: ${file}`);
  if (parsed.mcp.servers === undefined) return [];
  if (!isRecord(parsed.mcp.servers)) {
    throw new Error(`Global OpenCode config 'mcp.servers' must be an object: ${file}`);
  }
  return Object.keys(parsed.mcp.servers).sort();
}
