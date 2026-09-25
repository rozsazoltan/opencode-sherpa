import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { Registration } from "@opencode/plugin/promise/registration";

export const CAVECREW_AGENT_NAMES = [
  "cavecrew-investigator",
  "cavecrew-builder",
  "cavecrew-reviewer",
] as const;

interface AgentDefinition {
  description: string;
  mode: "subagent";
  system: string;
  permissions: Array<{ action: string; resource: string; effect: "deny" }>;
}

interface MarkdownDocument {
  frontmatter: Record<string, string>;
  body: string;
}

async function readInstalledAsset(installedRoot: string, relativePath: string): Promise<string> {
  if (!path.isAbsolute(installedRoot)) {
    throw new TypeError("The installed Caveman asset root must be an absolute path.");
  }

  const root = await realpath(installedRoot);
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

  try {
    return await readFile(assetPath, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read installed Caveman asset "${relativePath}": ${detail}`, { cause: error });
  }
}

function parseScalar(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "string") return parsed;
    } catch (error) {
      throw new Error(`${label} has invalid quoted frontmatter.`, { cause: error });
    }
    throw new Error(`${label} has invalid quoted frontmatter.`);
  }
  if (trimmed.startsWith("'")) {
    if (!trimmed.endsWith("'") || trimmed.length < 2) {
      throw new Error(`${label} has invalid quoted frontmatter.`);
    }
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }

  return trimmed.replace(/[ \t]+#.*$/u, "").trim();
}

function parseMarkdownDocument(markdown: string, label: string): MarkdownDocument {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/u.exec(markdown);
  if (!match) throw new Error(`Installed Caveman asset "${label}" has invalid frontmatter.`);

  const lines = (match[1] ?? "").split(/\r?\n/u);
  const frontmatter: Record<string, string> = {};
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const field = /^([A-Za-z0-9_-]+):(?:[ \t]*(.*))?$/u.exec(line);
    if (!field) continue;

    const name = field[1] ?? "";
    const value = field[2] ?? "";
    const block = /^[|>](?:[+-]?\d|[+-]|\d[+-])?$/u.test(value.trim());
    if (!block) {
      frontmatter[name] = parseScalar(value, label);
      continue;
    }

    const blockLines: string[] = [];
    while (index + 1 < lines.length) {
      const nextLine = lines[index + 1] ?? "";
      if (nextLine !== "" && !/^[ \t]+/u.test(nextLine)) break;
      blockLines.push(nextLine.trim());
      index += 1;
    }
    const content = blockLines.join("\n");
    frontmatter[name] = value.trim().startsWith(">")
      ? content.split(/\n\n/u).map((paragraph) => paragraph.replace(/\n/gu, " ")).join("\n\n").trim()
      : content.trim();
  }

  return {
    frontmatter,
    // The delimiter's following newline is syntax; keep the Markdown body itself intact.
    body: (match[2] ?? "").replace(/^\r?\n/u, ""),
  };
}

async function loadAgentDefinition(
  installedRoot: string,
  name: (typeof CAVECREW_AGENT_NAMES)[number],
): Promise<AgentDefinition> {
  const relativePath = path.join("agents", `${name}.md`);
  const document = parseMarkdownDocument(await readInstalledAsset(installedRoot, relativePath), relativePath);
  if (document.frontmatter.name !== name || !document.body) {
    throw new Error(`Installed Caveman agent "${name}" has invalid frontmatter or no body.`);
  }

  const description = document.frontmatter.description;
  if (!description) throw new Error(`Installed Caveman agent "${name}" has no description.`);

  let system = document.body;
  if (name === "cavecrew-reviewer") {
    const original = "`Bash` only for `git diff`/`git log -p`/`git show`. No mutating commands.";
    if (!system.includes(original)) throw new Error("Installed Caveman reviewer instructions have changed.");
    system = system.replace(
      original,
      "Shell is unavailable. Review only the diff or file excerpts supplied by the parent prompt. If missing, request that material; never claim to have inspected Git state.",
    );
  }
  if (name === "cavecrew-investigator") {
    const original = "`Bash` for `git log -S`/`git grep`/`find` when faster.";
    if (!system.includes(original)) throw new Error("Installed Caveman investigator instructions have changed.");
    system = system.replace(original, "Shell is unavailable; use only read-only search and file tools.");
  }

  return {
    description: description.trim().replace(/\s+/gu, " "),
    mode: "subagent",
    system,
    permissions: name === "cavecrew-builder"
      ? [{ action: "shell", resource: "*", effect: "deny" }]
      : [
          { action: "edit", resource: "*", effect: "deny" },
          { action: "shell", resource: "*", effect: "deny" },
        ],
  };
}

async function loadAgentDefinitions(installedRoot: string): Promise<Array<readonly [string, AgentDefinition]>> {
  return Promise.all(CAVECREW_AGENT_NAMES.map(async (name) => [
    name,
    await loadAgentDefinition(installedRoot, name),
  ] as const));
}

export async function registerCavecrewAgents(
  ctx: Pick<Context, "agent">,
  installedRoot: string,
): Promise<Registration> {
  const definitions = await loadAgentDefinitions(installedRoot);

  return ctx.agent.transform((editor) => {
    for (const [name, definition] of definitions) {
      if (editor.get(name) !== undefined) continue;
      editor.update(name, (agent) => {
        agent.mode = definition.mode;
        agent.description = definition.description;
        agent.system = definition.system;
        agent.permissions = definition.permissions;
      });
    }
  });
}
