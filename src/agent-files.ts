import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export const SHA256 = /^[a-f0-9]{64}$/u;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function lexicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableJson(value: unknown): string {
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

export function inspectPath(target: string): ReturnType<typeof lstatSync> | undefined {
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

export function ensureDirectory(target: string, mode = 0o700): void {
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

export function readTextFile(target: string): string | undefined {
  if (!assertRegularFile(target)) return undefined;
  return readFileSync(target, "utf8");
}

export function atomicWrite(target: string, contents: string | Buffer, mode = 0o600): void {
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

export function fileMode(target: string, fallback = 0o644): number {
  const stat = inspectPath(target);
  return stat ? Number(stat.mode) & 0o777 : fallback;
}
