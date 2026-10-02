import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { isRecord, lexicalCompare } from "./agent-files.ts";

export interface PackagedSkill {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly autoinvoke?: boolean;
  readonly path: string;
  readonly content: string;
  readonly files?: ReadonlyMap<string, Buffer>;
}

export interface ParsedSkillDocument {
  readonly name: string;
  readonly description: string;
  readonly autoinvoke?: boolean;
  readonly license?: string;
  readonly content: string;
}

export interface PackagedCommand {
  readonly name: string;
  readonly description?: string;
  readonly template: string;
  readonly path: string;
}

export interface PackagedInstruction {
  readonly id: string;
  readonly path: string;
  readonly content: string;
}

export interface SherpaTuning {
  readonly instructions: readonly PackagedInstruction[];
  readonly skills: readonly PackagedSkill[];
  readonly commands: readonly PackagedCommand[];
}

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTENT_ROOT = "tuning";
const CONTENT_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/u;

export function markdownFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const root = lstatSync(directory);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error(`Tuning content path must be a real directory: ${directory}`);
  }

  const files: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".md") files.push(absolute);
    }
  };

  visit(directory);
  return files.sort((a, b) => lexicalCompare(
    path.relative(directory, a).split(path.sep).join("/"),
    path.relative(directory, b).split(path.sep).join("/"),
  ));
}

function validatedRelativeName(root: string, target: string): string {
  const relative = path.relative(root, target).split(path.sep).join("/");
  if (!relative || !CONTENT_NAME.test(relative)) {
    throw new Error(`Invalid tuning content name derived from ${target}. Use lowercase kebab-case path segments.`);
  }
  return relative;
}

function parseDocument(sourceText: string, file: string, frontmatterRequired = true): {
  metadata: Record<string, unknown>;
  body: string;
} {
  const source = sourceText.replace(/^\uFEFF/u, "");
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u.exec(source);
  if (!match) {
    if (/^---[ \t]*(?:\r?\n|$)/u.test(source)) {
      throw new Error(`Markdown frontmatter is invalid: ${file}`);
    }
    if (frontmatterRequired) throw new Error(`Markdown content requires YAML frontmatter: ${file}`);
    const body = source.trim();
    if (!body) throw new Error(`Markdown content body must not be empty: ${file}`);
    return { metadata: {}, body };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(match[1] ?? "");
  } catch {
    throw new Error(`Markdown frontmatter is invalid: ${file}`);
  }
  if (!isRecord(parsed)) throw new Error(`Markdown frontmatter must be an object: ${file}`);

  const body = source.slice(match[0].length).trim();
  if (!body) throw new Error(`Markdown content body must not be empty: ${file}`);
  return { metadata: parsed, body };
}

function readDocument(file: string, frontmatterRequired = true): { metadata: Record<string, unknown>; body: string } {
  return parseDocument(readFileSync(file, "utf8"), file, frontmatterRequired);
}

function optionalString(metadata: Record<string, unknown>, key: string, file: string): string | undefined {
  const value = metadata[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Markdown frontmatter '${key}' must be a non-empty string: ${file}`);
  }
  return value.trim();
}

function assertAllowedKeys(metadata: Record<string, unknown>, allowed: readonly string[], file: string): void {
  const unsupported = Object.keys(metadata).find((key) => !allowed.includes(key));
  if (unsupported) throw new Error(`Unsupported frontmatter field '${unsupported}': ${file}`);
}

export function parseSkillDocument(source: string, id: string, file: string): ParsedSkillDocument {
  const { metadata, body } = parseDocument(source, file);
  assertAllowedKeys(metadata, ["name", "description", "autoinvoke", "metadata", "license", "compatibility"], file);
  const description = optionalString(metadata, "description", file);
  if (!description) throw new Error(`Skills require a description in frontmatter: ${file}`);

  const displayName = optionalString(metadata, "name", file) ?? id;
  const metadataValue = metadata.metadata;
  const metadataRecord = metadataValue === undefined ? {} : metadataValue;
  if (!isRecord(metadataRecord)) throw new Error(`Skill metadata must be an object: ${file}`);
  const autoinvokeValue = metadata.autoinvoke ?? metadataRecord["opencode/autoinvoke"];
  const autoinvoke = autoinvokeValue === "true"
    ? true
    : autoinvokeValue === "false"
      ? false
      : autoinvokeValue;
  if (autoinvoke !== undefined && typeof autoinvoke !== "boolean") {
    throw new Error(`Skill autoinvoke must be a boolean: ${file}`);
  }
  const license = typeof metadata.license === "string" ? metadata.license : undefined;

  return {
    name: displayName,
    description,
    ...(autoinvoke === undefined ? {} : { autoinvoke }),
    ...(license === undefined ? {} : { license }),
    content: body,
  };
}

function readSkills(directory: string): PackagedSkill[] {
  return markdownFiles(directory)
    .filter((file) => path.basename(file) === "SKILL.md")
    .map((file) => {
      const skillDirectory = path.dirname(file);
      const id = validatedRelativeName(directory, skillDirectory);
      const parsed = parseSkillDocument(readFileSync(file, "utf8"), id, file);

      return {
        id,
        name: parsed.name,
        description: parsed.description,
        ...(parsed.autoinvoke === undefined ? {} : { autoinvoke: parsed.autoinvoke }),
        path: file,
        content: parsed.content,
      };
    });
}

function readCommands(directory: string): PackagedCommand[] {
  const names = new Set<string>();
  return markdownFiles(directory).map((file) => {
    const { metadata, body } = readDocument(file, false);
    assertAllowedKeys(metadata, ["description"], file);
    const description = optionalString(metadata, "description", file);
    const commandPath = path.join(path.dirname(file), path.basename(file).replace(/\.md$/iu, ""));
    const name = validatedRelativeName(directory, commandPath);
    if (names.has(name)) {
      throw new Error(`Duplicate packaged command name '${name}' derived from ${file}.`);
    }
    names.add(name);
    return {
      name,
      ...(description === undefined ? {} : { description }),
      template: body,
      path: file,
    };
  });
}

function readInstructions(directory: string): PackagedInstruction[] {
  const ids = new Set<string>();
  return markdownFiles(directory).flatMap((file) => {
    const content = readFileSync(file, "utf8");
    if (!content.trim()) return [];

    const instructionPath = path.join(path.dirname(file), path.basename(file).replace(/\.md$/iu, ""));
    const id = validatedRelativeName(directory, instructionPath);
    if (ids.has(id)) {
      throw new Error(`Duplicate packaged instruction ID '${id}' derived from ${file}.`);
    }
    ids.add(id);
    return [{ id, path: file, content }];
  });
}

export function loadSherpaTuning(packageRoot = PACKAGE_ROOT): SherpaTuning {
  const tuningRoot = path.join(packageRoot, CONTENT_ROOT);
  if (existsSync(tuningRoot)) {
    const root = lstatSync(tuningRoot);
    if (!root.isDirectory() || root.isSymbolicLink()) {
      throw new Error(`Tuning content path must be a real directory: ${tuningRoot}`);
    }
  }
  const instructions = readInstructions(path.join(tuningRoot, "instructions"));

  return {
    instructions,
    skills: readSkills(path.join(tuningRoot, "skills")),
    commands: readCommands(path.join(tuningRoot, "commands")),
  };
}
