import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { SkillEditor } from "@opencode/plugin/promise/skill";
import type { Registration } from "@opencode/plugin/promise/registration";

const SKILL_NAMES = ["caveman", "caveman-commit", "caveman-review"] as const;
const CAVEMAN_PACKAGE_ROOT = fileURLToPath(
  new URL(".", import.meta.resolve("caveman-installer/package.json")),
);

type SkillInfo = Parameters<SkillEditor["add"]>[0];

interface SkillDocument {
  name: string;
  description: string;
  content: string;
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

function parseSkillDocument(markdown: string, expectedName: string): SkillDocument {
  const frontmatterMatch = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(markdown);
  if (!frontmatterMatch) {
    throw new Error(`Caveman skill "${expectedName}" has invalid frontmatter.`);
  }

  const frontmatterLines = (frontmatterMatch[1] ?? "").split(/\r?\n/);
  let name: string | undefined;
  let description: string | undefined;

  for (let index = 0; index < frontmatterLines.length; index += 1) {
    const line = frontmatterLines[index] ?? "";
    const nameMatch = /^name:\s*(.*?)\s*$/.exec(line);
    if (nameMatch) {
      name = nameMatch[1];
      continue;
    }

    if (!/^description:\s*>[+-]?\s*$/.test(line)) continue;

    const descriptionLines: string[] = [];
    while (index + 1 < frontmatterLines.length) {
      const nextLine = frontmatterLines[index + 1] ?? "";
      if (nextLine.trim() === "") {
        descriptionLines.push("");
        index += 1;
        continue;
      }
      if (!/^[ \t]+/.test(nextLine)) break;

      descriptionLines.push(nextLine.trimStart());
      index += 1;
    }
    description = foldDescriptionLines(descriptionLines);
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

async function loadCavemanSkills(): Promise<SkillInfo[]> {
  return Promise.all(SKILL_NAMES.map(async (expectedName) => {
    const skillPath = path.join(CAVEMAN_PACKAGE_ROOT, "skills", expectedName, "SKILL.md");
    const markdown = await readFile(skillPath, "utf8");
    const document = parseSkillDocument(markdown, expectedName);

    // Skill.Info brands these strings; the pinned upstream frontmatter supplies
    // the validated values used by the runtime schema.
    return {
      id: document.name,
      name: document.name,
      description: document.description,
      path: skillPath,
      content: document.content,
    } as SkillInfo;
  }));
}

export async function registerCavemanSkills(
  ctx: Pick<Context, "skill">,
): Promise<Registration> {
  const skills = await loadCavemanSkills();

  return ctx.skill.transform((editor) => {
    for (const skill of skills) {
      if (editor.get(skill.id) !== undefined) continue;
      editor.add(skill);
    }
  });
}
