import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { SkillEditor } from "@opencode/plugin/promise/skill";
import type { Registration } from "@opencode/plugin/promise/registration";

export const CAVEMAN_SKILL_NAMES = [
  "caveman", "caveman-commit", "caveman-review", "caveman-help",
  "caveman-compress", "caveman-stats", "cavecrew",
] as const;

type SkillInfo = Parameters<SkillEditor["add"]>[0];

interface SkillDocument {
  name: string;
  description: string;
  content: string;
}

const OPENCODE_HELP = `# Caveman Help (OpenCode)

Use the Caveman skills in this installation: caveman (lite, full, ultra, wenyan-lite,
wenyan-full, wenyan-ultra, off), caveman-commit, caveman-review,
caveman-compress, caveman-stats, and cavecrew. The three cavecrew agents are
cavecrew-investigator, cavecrew-builder, and cavecrew-reviewer.

The /caveman, /caveman-help, /caveman-compress, /caveman-stats,
/caveman-commit, and /caveman-review commands are provided by Sherpa at
runtime; no host configuration sync or restart is required. Caveman mode is
activated explicitly for the current session; Claude Code hooks and CAVEMAN_DEFAULT_MODE are not
installed here. Stop with "normal mode" or /caveman off. The stats skill only
reports session usage when OpenCode actually supplies it; savings are unknown.
`;

const OPENCODE_STATS = `# Caveman Stats (OpenCode)

If OpenCode provides the current session's actual token usage, report those
numbers with their source. Otherwise report that current session usage is
unavailable. Do not read Claude transcripts or infer savings, costs, or mode
attribution from the active mode. No Claude Code usage hook is installed.
`;

function adaptContent(name: string, content: string): string {
  if (name === "caveman-help") return OPENCODE_HELP;
  if (name === "caveman-stats") return OPENCODE_STATS;
  if (name === "caveman-compress") {
    const rules = content.slice(content.indexOf("## Compression Rules"));
    if (!rules.startsWith("## Compression Rules")) {
      throw new Error("Caveman compression rules are missing from the installed skill asset.");
    }
    return `# Caveman Compress (OpenCode)

For an explicitly requested natural-language file, use OpenCode's normal
read/edit tools to apply the upstream compression rules below; do not run
Claude-specific Python scripts. Reject source/config files, symlinks, and
existing *.original.md backups. Before changing the source, create a readable
backup outside every skill directory and repository (under the host's data
directory); use a distinct backup path for each original file and never
overwrite an existing backup. If a safe backup cannot be made, leave the
original untouched. Preserve code blocks, paths, commands and formatting.
Review the diff before reporting success. If tools or write permission are
unavailable, explain the blocker instead of claiming compression succeeded.

${rules}`;
  }
  if (name === "cavecrew") {
    const chainingHeading = "## Chaining patterns";
    if (!content.includes(chainingHeading)) {
      throw new Error("Cavecrew chaining guidance is missing from the installed skill asset.");
    }

    return content.replace(/`Explore` \(vanilla\)/gu, "a general-purpose codebase explorer")
      .replace(/`feature-dev:code-architect`/gu, "the main thread")
      .replace(/`Code Reviewer` \(vanilla\)/gu, "a general-purpose reviewer")
      .replace(/(?=Cavecrew =)/u,
        "The cavecrew subagents are registered by Sherpa at runtime in OpenCode.\n\n")
      .replace(chainingHeading, `## OpenCode reviewer handoff

The OpenCode cavecrew-reviewer cannot run shell commands or inspect Git state. Before invoking it, the main thread MUST provide the relevant diff, or relevant file excerpts showing the changes and enough surrounding context, in the prompt/context. Do not ask it to run \`git diff\`, \`git log\`, or \`git show\`, and do not claim it has read a diff, branch, or repository unless that content was explicitly supplied. If the needed diff or excerpts are unavailable, obtain them in the main thread first.

${chainingHeading}`);
  }
  return content;
}

function foldDescriptionLines(lines: readonly string[]): string {
  const paragraphs: string[] = [];
  let currentParagraph: string[] = [];

  for (const line of lines) {
    const text = line.trim();
    if (text) {
      currentParagraph.push(text);
      continue;
    }

    if (currentParagraph.length > 0) {
      paragraphs.push(currentParagraph.join(" "));
      currentParagraph = [];
    }
    paragraphs.push("");
  }

  if (currentParagraph.length > 0) paragraphs.push(currentParagraph.join(" "));
  return paragraphs.join("\n").trim();
}

function parseFrontmatterScalar(value: string, expectedName: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "string") return parsed;
    } catch (error) {
      throw new Error(`Caveman skill "${expectedName}" has invalid quoted frontmatter.`, { cause: error });
    }
    throw new Error(`Caveman skill "${expectedName}" has invalid quoted frontmatter.`);
  }
  if (trimmed.startsWith("'")) {
    if (!trimmed.endsWith("'") || trimmed.length < 2) {
      throw new Error(`Caveman skill "${expectedName}" has invalid quoted frontmatter.`);
    }
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  return trimmed.replace(/[ \t]+#.*$/u, "").trim();
}

function parseSkillDocument(markdown: string, expectedName: string): SkillDocument {
  const frontmatterMatch = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/u.exec(markdown);
  if (!frontmatterMatch) {
    throw new Error(`Caveman skill "${expectedName}" has invalid frontmatter.`);
  }

  const frontmatterLines = (frontmatterMatch[1] ?? "").split(/\r?\n/);
  let name: string | undefined;
  let description: string | undefined;

  for (let index = 0; index < frontmatterLines.length; index += 1) {
    const line = frontmatterLines[index] ?? "";
    const field = /^([A-Za-z0-9_-]+):(?:[ \t]*(.*))?$/u.exec(line);
    if (!field) continue;

    const fieldName = field[1] ?? "";
    const value = field[2] ?? "";
    const block = /^[|>](?:[+-]?\d|[+-]|\d[+-])?$/u.test(value.trim());
    let parsedValue: string;
    if (block) {
      const blockLines: string[] = [];
      while (index + 1 < frontmatterLines.length) {
        const nextLine = frontmatterLines[index + 1] ?? "";
        if (nextLine !== "" && !/^[ \t]+/u.test(nextLine)) break;
        blockLines.push(nextLine.trim());
        index += 1;
      }
      const blockContent = blockLines.join("\n");
      parsedValue = value.trim().startsWith(">")
        ? foldDescriptionLines(blockLines)
        : blockContent.trim();
    } else {
      parsedValue = parseFrontmatterScalar(value, expectedName);
    }

    if (fieldName === "name") {
      name = parsedValue;
      continue;
    }
    if (fieldName === "description") description = parsedValue;
  }

  if (!name || name !== expectedName) {
    throw new Error(`Caveman skill "${expectedName}" has an unexpected frontmatter name.`);
  }
  if (!description) {
    throw new Error(`Caveman skill "${expectedName}" has no folded description.`);
  }

  // The newline immediately after the closing delimiter is frontmatter syntax;
  // preserve all actual Markdown body content, including its final newline.
  const content = (frontmatterMatch[2] ?? "").replace(/^\r?\n/, "");

  return { name, description, content };
}

async function readInstalledSkill(
  installedRoot: string,
  name: (typeof CAVEMAN_SKILL_NAMES)[number],
): Promise<{ path: string; markdown: string }> {
  if (!path.isAbsolute(installedRoot)) {
    throw new TypeError("The installed Caveman asset root must be an absolute path.");
  }

  const root = await realpath(installedRoot);
  const relativePath = path.join("skills", name, "SKILL.md");
  const skillPath = await realpath(path.resolve(root, relativePath));
  const relativeSkillPath = path.relative(root, skillPath);
  if (
    relativeSkillPath === "" ||
    relativeSkillPath === ".." ||
    relativeSkillPath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeSkillPath)
  ) {
    throw new Error(`Installed Caveman asset escapes its payload root: ${relativePath}`);
  }

  let markdown: string;
  try {
    markdown = await readFile(skillPath, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read installed Caveman asset "${relativePath}": ${detail}`, { cause: error });
  }
  return { path: skillPath, markdown };
}

async function loadCavemanSkills(installedRoot: string): Promise<SkillInfo[]> {
  return Promise.all(CAVEMAN_SKILL_NAMES.map(async (expectedName) => {
    const { path: skillPath, markdown } = await readInstalledSkill(installedRoot, expectedName);
    const document = parseSkillDocument(markdown, expectedName);

    // Skill.Info brands these strings; the installed frontmatter supplies
    // the validated values used by the runtime schema.
    return {
      id: document.name,
      name: document.name,
      description: document.description,
      path: skillPath,
      content: adaptContent(expectedName, document.content),
    } as SkillInfo;
  }));
}

export async function registerCavemanSkills(
  ctx: Pick<Context, "skill">,
  installedRoot: string,
): Promise<Registration> {
  const skills = await loadCavemanSkills(installedRoot);

  return ctx.skill.transform((editor) => {
    for (const skill of skills) {
      if (editor.get(skill.id) !== undefined) continue;
      editor.add(skill);
    }
  });
}
