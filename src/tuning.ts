import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Skill } from "@opencode/plugin";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { CommandDefinition } from "@opencode/plugin/promise/command";
import type { Registration } from "@opencode/plugin/promise/registration";
import type { SkillEditor } from "@opencode/plugin/promise/skill";
import { parse as parseYaml } from "yaml";

type PackagedSkill = Parameters<SkillEditor["add"]>[0];

export interface PackagedCommand {
  readonly name: string;
  readonly description?: string;
  readonly template: string;
}

export interface SherpaTuning {
  readonly instructions: readonly string[];
  readonly skills: readonly PackagedSkill[];
  readonly commands: readonly PackagedCommand[];
}

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTENT_ROOT = "tuning";
const CONTENT_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lexicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function markdownFiles(directory: string): string[] {
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

function readDocument(file: string, frontmatterRequired = true): { metadata: Record<string, unknown>; body: string } {
  const source = readFileSync(file, "utf8").replace(/^\uFEFF/u, "");
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

function readSkills(directory: string): PackagedSkill[] {
  return markdownFiles(directory)
    .filter((file) => path.basename(file) === "SKILL.md")
    .map((file) => {
      const { metadata, body } = readDocument(file);
      assertAllowedKeys(metadata, ["name", "description", "autoinvoke", "metadata", "license", "compatibility"], file);
      const description = optionalString(metadata, "description", file);
      if (!description) throw new Error(`Skills require a description in frontmatter: ${file}`);

      const skillDirectory = path.dirname(file);
      const id = validatedRelativeName(directory, skillDirectory);
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

      return {
        id: Skill.ID.make(id),
        name: Skill.Name.make(displayName),
        description,
        ...(autoinvoke === undefined ? {} : { autoinvoke }),
        path: file as PackagedSkill["path"],
        content: body,
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
    };
  });
}

function renderCommandTemplate(template: string, argumentsText: string): string {
  if (template.includes("$ARGUMENTS")) {
    return template.replaceAll("$ARGUMENTS", () => argumentsText);
  }
  if (argumentsText.trim().length === 0) return template;
  return `${template}\n\n${argumentsText}`;
}

export function loadSherpaTuning(packageRoot = PACKAGE_ROOT): SherpaTuning {
  const tuningRoot = path.join(packageRoot, CONTENT_ROOT);
  if (existsSync(tuningRoot)) {
    const root = lstatSync(tuningRoot);
    if (!root.isDirectory() || root.isSymbolicLink()) {
      throw new Error(`Tuning content path must be a real directory: ${tuningRoot}`);
    }
  }
  const instructionFiles = markdownFiles(path.join(tuningRoot, "instructions"));
  const instructions = instructionFiles
    .map((file) => readFileSync(file, "utf8").trim())
    .filter((content) => content.length > 0);

  return {
    instructions,
    skills: readSkills(path.join(tuningRoot, "skills")),
    commands: readCommands(path.join(tuningRoot, "commands")),
  };
}

export async function registerSherpaSkills(
  ctx: Pick<Context, "skill">,
  skills: readonly PackagedSkill[],
): Promise<Registration | undefined> {
  if (skills.length === 0) return undefined;
  return ctx.skill.transform((editor) => {
    for (const skill of skills) {
      if (editor.get(skill.id)) continue;
      editor.add(skill);
    }
  });
}

export async function registerSherpaCommands(
  ctx: Pick<Context, "command" | "session">,
  commands: readonly PackagedCommand[],
): Promise<Registration | undefined> {
  if (commands.length === 0) return undefined;
  return ctx.command.transform((editor) => {
    for (const command of commands) {
      const definition: CommandDefinition = {
        name: command.name,
        ...(command.description === undefined ? {} : { description: command.description }),
        execute: async ({ sessionID, prompt, delivery }) => {
          const text = renderCommandTemplate(command.template, prompt.text);
          const files = prompt.files?.map(({ uri, name, description }) => ({
            uri,
            ...(name === undefined ? {} : { name }),
            ...(description === undefined ? {} : { description }),
          }));
          const agents = prompt.agents?.map(({ name }) => ({ name }));
          const skills = prompt.skills?.map(({ id }) => ({ id }));
          await ctx.session.prompt({
            sessionID,
            text,
            delivery,
            ...(files === undefined ? {} : { files }),
            ...(agents === undefined ? {} : { agents }),
            ...(skills === undefined ? {} : { skills }),
          });
        },
      };
      editor.add(definition);
    }
  });
}
