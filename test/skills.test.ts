import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { SkillEditor } from "@opencode/plugin/promise/skill";
import type { Registration } from "@opencode/plugin/promise/registration";
import { CAVEMAN_SKILL_NAMES, registerCavemanSkills } from "../src/skills.ts";

const SKILL_NAMES = ["caveman", "caveman-commit", "caveman-review"] as const;
const CAVEMAN_PACKAGE_ROOT = fileURLToPath(
  new URL(".", import.meta.resolve("caveman-installer/package.json")),
);
const PROJECT_PACKAGE_JSON = fileURLToPath(new URL("../package.json", import.meta.url));

const EXPECTED_DESCRIPTIONS: Record<(typeof SKILL_NAMES)[number], string> = {
  caveman: "Ultra-compressed communication mode that cuts output tokens while keeping technical accuracy. Levels: lite, full, ultra and the wenyan variants. Use for /caveman, \"caveman mode\", \"talk like caveman\", \"be brief\" or \"less tokens\".",
  "caveman-commit": "Write a Conventional Commits message compressed to intent only. Use for \"write a commit\", \"commit message\", /commit or /caveman-commit.",
  "caveman-review": "Compressed code review - one line per finding with location, problem and fix. Use for /caveman-review, \"review this PR\", or \"review the diff\".",
};

type SkillInfo = Parameters<SkillEditor["add"]>[0];

interface ExpectedSkill {
  name: string;
  path: string;
  content: string;
}

async function readExpectedSkill(name: (typeof SKILL_NAMES)[number]): Promise<ExpectedSkill> {
  const skillPath = path.join(CAVEMAN_PACKAGE_ROOT, "skills", name, "SKILL.md");
  const markdown = await readFile(skillPath, "utf8");
  const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(markdown);
  if (!match) throw new Error(`Upstream skill "${name}" has invalid frontmatter.`);

  return {
    name,
    path: skillPath,
    content: (match[1] ?? "").replace(/^\r?\n/, ""),
  };
}

async function setupSkills(existing: Map<string, SkillInfo> = new Map()) {
  const added = new Map<string, SkillInfo>();
  const registration: Registration = { dispose: async () => {} };
  const transform = async (
    callback: (editor: SkillEditor) => void,
  ): Promise<Registration> => {
    callback({
      get: (id) => existing.get(id),
      add: (skill) => { added.set(skill.id, skill); },
    } as SkillEditor);
    return registration;
  };

  const ctx = { skill: { transform } } as unknown as Pick<Context, "skill">;
  return { added, registration: await registerCavemanSkills(ctx) };
}

test("registers exactly the three independent upstream skills with their Markdown bodies", async () => {
  const { added, registration } = await setupSkills();

  expect(registration).toBeDefined();
  expect([...added.keys()].sort()).toEqual([...CAVEMAN_SKILL_NAMES].sort());

  for (const name of SKILL_NAMES) {
    const skill = added.get(name);
    const upstream = await readExpectedSkill(name);

    expect(skill).toBeDefined();
    expect(String(skill?.id)).toBe(name);
    expect(String(skill?.name)).toBe(name);
    expect(skill?.description).toBe(EXPECTED_DESCRIPTIONS[name]);
    expect(String(skill?.path)).toBe(upstream.path);
    expect(path.isAbsolute(skill?.path ?? "")).toBe(true);
    expect(skill?.path).toEndWith("SKILL.md");
    expect(skill?.content).toBe(upstream.content);
    expect(skill?.content).not.toStartWith("---");
  }
});

test("leaves colliding skills untouched and adds only missing Caveman skills", async () => {
  const collision = {
    id: "caveman",
    name: "existing caveman",
    description: "Owned by another source.",
    path: "/existing/SKILL.md",
    content: "Do not replace this skill.",
  } as SkillInfo;
  const existing = new Map<string, SkillInfo>([[String(collision.id), collision]]);
  const { added } = await setupSkills(existing);

  expect(existing.get("caveman")).toBe(collision);
  expect(added.has("caveman")).toBe(false);
  expect([...added.keys()].sort()).toEqual([...CAVEMAN_SKILL_NAMES].filter((name) => name !== "caveman").sort());
});

test("adapts dependent Caveman skills to OpenCode without running Claude hooks", async () => {
  const { added } = await setupSkills();
  for (const name of ["caveman-help", "caveman-compress", "caveman-stats", "cavecrew"]) {
    expect(added.get(name)).toBeDefined();
    expect(path.isAbsolute(String(added.get(name)?.path))).toBe(true);
  }
  expect(added.get("caveman-help")?.content).toContain("Caveman Help (OpenCode)");
  expect(added.get("caveman-help")?.content).not.toContain("Saves ~46%");
  expect(added.get("caveman-compress")?.content).toContain("## Compression Rules");
  expect(added.get("caveman-compress")?.content).not.toContain("python3 -m scripts");
  expect(added.get("caveman-stats")?.content).toContain("unavailable");
  expect(added.get("cavecrew")?.content).toContain("registered by Sherpa at runtime in OpenCode");
});

test("requires the main thread to provide review material to OpenCode cavecrew-reviewer", async () => {
  const { added } = await setupSkills();
  const cavecrew = added.get("cavecrew")?.content ?? "";

  expect(cavecrew).toContain("cannot run shell commands or inspect Git state");
  expect(cavecrew).toContain("main thread MUST provide the relevant diff");
  expect(cavecrew).toContain("relevant file excerpts showing the changes");
  expect(cavecrew).toContain("Do not ask it to run `git diff`, `git log`, or `git show`");
  expect(cavecrew).toContain("unless that content was explicitly supplied");
});

test("does not add dependencies from CC Switch", async () => {
  const manifest = JSON.parse(await readFile(PROJECT_PACKAGE_JSON, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const dependencyNames = [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ];

  expect(dependencyNames.filter((name) => /cc[-.]?switch/i.test(name))).toEqual([]);
});
