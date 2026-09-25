import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { CommandDefinition } from "@opencode/plugin/promise/command";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { Registration } from "@opencode/plugin/promise/registration";

const CAVEMAN_COMMAND_NAMES = [
  "caveman",
  "caveman-commit",
  "caveman-review",
  "caveman-help",
  "caveman-stats",
  "caveman-compress",
] as const;

interface CommandDocument {
  name: string;
  description: string;
  template: string;
}

const OPENCODE_COMPRESSION_BACKUP_INSTRUCTION =
  "Before overwriting, create a readable backup outside the repository and every skill directory (under the host's data directory). Use a distinct backup path for each original file and never overwrite an existing backup. If a safe backup cannot be made, leave the original untouched.";

function foldDescription(lines: readonly string[]): string {
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    const text = line.trim();
    if (text) {
      current.push(text);
      continue;
    }
    if (current.length > 0) {
      paragraphs.push(current.join(" "));
      current = [];
    }
    paragraphs.push("");
  }
  if (current.length > 0) paragraphs.push(current.join(" "));
  return paragraphs.join("\n").trim();
}

function parseDescription(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith(">") || trimmed.startsWith("|")) {
    throw new Error(`Installed Caveman command "${label}" has invalid description frontmatter.`);
  }
  if (trimmed.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "string") return parsed;
    } catch (error) {
      throw new Error(`Installed Caveman command "${label}" has invalid quoted description.`, { cause: error });
    }
    throw new Error(`Installed Caveman command "${label}" has invalid quoted description.`);
  }
  if (trimmed.startsWith("'")) {
    if (!trimmed.endsWith("'") || trimmed.length < 2) {
      throw new Error(`Installed Caveman command "${label}" has invalid quoted description.`);
    }
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  return trimmed.replace(/[ \t]+#.*$/u, "").trim();
}

function parseCommandDocument(markdown: string, name: (typeof CAVEMAN_COMMAND_NAMES)[number]): CommandDocument {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/u.exec(markdown);
  if (!match) throw new Error(`Installed Caveman command "${name}" has invalid frontmatter.`);

  const lines = (match[1] ?? "").split(/\r?\n/u);
  let description: string | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const field = /^description:[ \t]*(.*)$/u.exec(lines[index] ?? "");
    if (!field) continue;

    const value = field[1] ?? "";
    if (/^[|>](?:[+-]?\d|[+-]|\d[+-])?$/u.test(value.trim())) {
      const descriptionLines: string[] = [];
      while (index + 1 < lines.length) {
        const nextLine = lines[index + 1] ?? "";
        if (nextLine !== "" && !/^[ \t]+/u.test(nextLine)) break;
        descriptionLines.push(nextLine.trim());
        index += 1;
      }
      description = value.trim().startsWith(">")
        ? foldDescription(descriptionLines)
        : descriptionLines.join("\n").trim();
    } else {
      description = parseDescription(value, name);
    }
  }

  const template = (match[2] ?? "").replace(/^\r?\n/u, "");
  if (!description) throw new Error(`Installed Caveman command "${name}" has no description.`);
  if (!template.trim()) throw new Error(`Installed Caveman command "${name}" has no body.`);
  return { name, description: description.trim().replace(/\s+/gu, " "), template };
}

function adaptCommandDocument(document: CommandDocument): CommandDocument {
  if (document.name !== "caveman-compress") return document;

  const upstreamBackupInstruction = /Original is backed up as `<file>\.original\.md` before\s+overwrite\./u;
  if (!upstreamBackupInstruction.test(document.template)) {
    throw new Error('Installed Caveman command "caveman-compress" has unsupported backup instructions.');
  }

  return {
    ...document,
    template: document.template.replace(upstreamBackupInstruction, OPENCODE_COMPRESSION_BACKUP_INSTRUCTION),
  };
}

async function readInstalledCommand(installedRoot: string, name: (typeof CAVEMAN_COMMAND_NAMES)[number]): Promise<CommandDocument> {
  if (!path.isAbsolute(installedRoot)) {
    throw new TypeError("The installed Caveman asset root must be an absolute path.");
  }

  const root = await realpath(installedRoot);
  const relativePath = path.join("commands", `${name}.md`);
  const assetPath = await realpath(path.resolve(root, relativePath));
  const relativeAssetPath = path.relative(root, assetPath);
  if (
    relativeAssetPath === "" ||
    relativeAssetPath === ".." ||
    relativeAssetPath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeAssetPath)
  ) {
    throw new Error(`Installed Caveman asset escapes its payload root: ${relativePath}`);
  }

  let markdown: string;
  try {
    markdown = await readFile(assetPath, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read installed Caveman asset "${relativePath}": ${detail}`, { cause: error });
  }
  return adaptCommandDocument(parseCommandDocument(markdown, name));
}

function createCommand(
  ctx: Pick<Context, "session">,
  definition: CommandDocument,
): CommandDefinition {
  return {
    name: definition.name,
    description: definition.description,
    execute: async (input) => {
      const { files, agents, skills, ...prompt } = input.prompt;
      await ctx.session.prompt({
        ...prompt,
        sessionID: input.sessionID,
        text: definition.template.replaceAll("$ARGUMENTS", () => prompt.text),
        delivery: input.delivery,
        ...(files === undefined ? {} : {
          files: files.map(({ uri, name, description, mention }) => ({
            uri,
            ...(name === undefined ? {} : { name }),
            ...(description === undefined ? {} : { description }),
            ...(mention === undefined ? {} : { mention }),
          })),
        }),
        ...(agents === undefined ? {} : {
          agents: agents.map(({ name, mention }) => ({
            name,
            ...(mention === undefined ? {} : { mention }),
          })),
        }),
        ...(skills === undefined ? {} : {
          skills: skills.map(({ id, mention }) => ({
            id,
            ...(mention === undefined ? {} : { mention }),
          })),
        }),
      });
    },
  };
}

export async function registerCavemanCommands(
  ctx: Pick<Context, "command" | "session">,
  installedRoot: string,
): Promise<Registration> {
  const documents = await Promise.all(CAVEMAN_COMMAND_NAMES.map((name) => readInstalledCommand(installedRoot, name)));
  const definitions = documents.map((document) => createCommand(ctx, document));
  const existing = await ctx.command.list();
  const existingNames = new Set(existing.data.map(({ name }) => name));

  // V2.0.16 command.add is a Map.set, so skip names already visible in the list.
  // This snapshot cannot prevent a later transform from replacing a command.
  return ctx.command.transform((editor) => {
    for (const definition of definitions) {
      if (existingNames.has(definition.name)) continue;
      editor.add(definition);
    }
  });
}
