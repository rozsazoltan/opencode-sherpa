import os from "node:os";
import path from "node:path";
import type { PermissionEvaluation } from "@opencode/plugin/promise/permission";

const SUPPORTED_ACTIONS = new Set<PermissionEvaluation["action"]>([
  "external_directory",
  "read",
  "edit",
]);
const PERMISSION_OPTION_KEYS = new Set(["allowDirectories", "denyDirectories"]);

export interface PathApi {
  readonly sep: string;
  isAbsolute(path: string): boolean;
  normalize(path: string): string;
  relative(from: string, to: string): string;
}

type PermissionDecision = Pick<PermissionEvaluation, "action" | "effect" | "resources">;

interface ParsedResource {
  readonly path: string;
  readonly directoryPattern: boolean;
}

type ResourceResult = ParsedResource | "ambiguous" | undefined;

interface ParsedPermissionOptions {
  readonly allowDirectories: readonly string[];
  readonly denyDirectories: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasUnsupportedGlob(value: string): boolean {
  return /[*?\[\]{}]/.test(value) || /[!@+]\(/.test(value);
}

function hasAmbiguousWindowsPath(value: string, pathApi: PathApi): boolean {
  if (pathApi.sep !== "\\") return false;
  if (value.startsWith("\\\\?\\") || value.startsWith("\\\\.\\")) return true;
  return value.split(/[\\/]/).some((part) => part !== "." && part !== ".." && /[. ]$/.test(part));
}

function isAbsoluteDirectory(value: string, pathApi: PathApi): boolean {
  if (!pathApi.isAbsolute(value)) return false;
  if (pathApi.sep !== "\\") return true;

  const normalized = pathApi.normalize(value);
  if (normalized.startsWith("\\\\?\\") || normalized.startsWith("\\\\.\\")) return false;
  return /^[A-Za-z]:\\/.test(normalized) || /^\\\\[^\\]+\\[^\\]+\\/.test(normalized);
}

function normalizeDirectories(
  value: unknown,
  optionName: "allowDirectories" | "denyDirectories",
  pathApi: PathApi,
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new TypeError(`Invalid Sherpa configuration: options.permissions.${optionName} must be an array of absolute paths.`);
  }

  const directories: string[] = [];
  for (const [index, directory] of value.entries()) {
    if (typeof directory !== "string") {
      throw new TypeError(`Invalid Sherpa configuration: options.permissions.${optionName}[${index}] must be a string path.`);
    }
    if (directory.includes("\0")) {
      throw new TypeError(`Invalid Sherpa configuration: options.permissions.${optionName}[${index}] must not contain NUL characters.`);
    }
    if (hasAmbiguousWindowsPath(directory, pathApi)) {
      throw new TypeError(`Invalid Sherpa configuration: options.permissions.${optionName}[${index}] has an ambiguous Windows path.`);
    }
    if (hasUnsupportedGlob(directory)) {
      throw new TypeError(`Invalid Sherpa configuration: options.permissions.${optionName}[${index}] must be a literal path without globs.`);
    }
    if (!isAbsoluteDirectory(directory, pathApi)) {
      throw new TypeError(`Invalid Sherpa configuration: options.permissions.${optionName}[${index}] must be an absolute path.`);
    }

    directories.push(pathApi.normalize(directory));
  }

  return directories;
}

function readPermissionOptions(options: unknown, pathApi: PathApi): ParsedPermissionOptions {
  if (options === undefined) return { allowDirectories: [], denyDirectories: [] };
  if (!isRecord(options)) {
    throw new TypeError("Invalid Sherpa configuration: plugin options must be an object.");
  }

  const permissions = options.permissions;
  if (permissions === undefined) return { allowDirectories: [], denyDirectories: [] };
  if (!isRecord(permissions)) {
    throw new TypeError("Invalid Sherpa configuration: options.permissions must be an object.");
  }

  const unsupportedKey = Object.keys(permissions).find((key) => !PERMISSION_OPTION_KEYS.has(key));
  if (unsupportedKey !== undefined) {
    throw new TypeError(`Invalid Sherpa configuration: options.permissions.${unsupportedKey} is not supported.`);
  }

  return {
    allowDirectories: normalizeDirectories(permissions.allowDirectories, "allowDirectories", pathApi),
    denyDirectories: normalizeDirectories(permissions.denyDirectories, "denyDirectories", pathApi),
  };
}

function parseResource(resource: unknown, pathApi: PathApi): ResourceResult {
  if (typeof resource !== "string" || resource.includes("\0")) return undefined;

  const directoryPattern = resource.endsWith("/*") || resource.endsWith(`${pathApi.sep}*`);
  const candidate = directoryPattern ? resource.slice(0, -1) : resource;
  if (hasAmbiguousWindowsPath(candidate, pathApi)) return "ambiguous";
  if (hasUnsupportedGlob(candidate) || !isAbsoluteDirectory(candidate, pathApi)) return undefined;

  return { path: pathApi.normalize(candidate), directoryPattern };
}

function isWithin(root: string, candidate: string, pathApi: PathApi): boolean {
  const relative = pathApi.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${pathApi.sep}`) &&
    !pathApi.isAbsolute(relative)
  );
}

function isExcluded(
  resource: ParsedResource,
  action: PermissionEvaluation["action"],
  denyDirectories: readonly string[],
  pathApi: PathApi,
): boolean {
  // Directory requests cover descendants, so a parent gate cannot bypass an excluded child.
  const isDirectoryCapability = action === "external_directory" || resource.directoryPattern;
  return denyDirectories.some((directory) =>
    isWithin(directory, resource.path, pathApi) ||
    (isDirectoryCapability && isWithin(resource.path, directory, pathApi))
  );
}

/** Enforces lexical path policy; it does not resolve or contain filesystem symlinks. */
export function createDirectoryPermissionEvaluator(
  options: unknown = {},
  pathApi: PathApi = path,
): (evaluation: PermissionDecision) => void {
  const configured = readPermissionOptions(options, pathApi);
  const allowDirectories = [
    pathApi.normalize(path.join(os.tmpdir(), "opencode")),
    ...configured.allowDirectories,
  ];

  return (evaluation): void => {
    if (!SUPPORTED_ACTIONS.has(evaluation.action) || evaluation.effect === "deny") return;
    if (!Array.isArray(evaluation.resources) || evaluation.resources.length === 0) return;

    const resources = evaluation.resources.map((resource) => parseResource(resource, pathApi));
    if (resources.some((resource) =>
      resource === "ambiguous" || (
        resource !== undefined && isExcluded(resource, evaluation.action, configured.denyDirectories, pathApi)
      )
    )) {
      evaluation.effect = "deny";
      return;
    }

    if (evaluation.effect !== "ask" || resources.some((resource) => resource === undefined)) return;

    if (resources.every((resource) =>
      resource !== undefined && resource !== "ambiguous" &&
      allowDirectories.some((directory) => isWithin(directory, resource.path, pathApi))
    )) {
      evaluation.effect = "allow";
    }
  };
}
