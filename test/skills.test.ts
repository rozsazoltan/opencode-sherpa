import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { SkillEditor } from "@opencode/plugin/promise/skill";
import type { Registration } from "@opencode/plugin/promise/registration";
import { CAVEMAN_SKILL_NAMES, registerCavemanSkills } from "../src/skills.ts";

const SKILL_NAMES = ["caveman", "caveman-commit", "caveman-review"] as const;
const INSTALLER_ROOT = fileURLToPath(new URL("../node_modules/caveman-installer/", import.meta.url));
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

async function createPayload(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-sherpa-skills-"));
  await Promise.all([
    mkdir(path.join(root, "agents"), { recursive: true }),
    mkdir(path.join(root, "commands"), { recursive: true }),
    mkdir(path.join(root, "skills"), { recursive: true }),
    mkdir(path.join(root, "plugins/caveman"), { recursive: true }),
  ]);
  await writeFile(path.join(root, "AGENTS.md"), "# Isolated installer fixture\n");
  await Promise.all(CAVEMAN_SKILL_NAMES.map(async (name) => {
    await mkdir(path.join(root, "skills", name), { recursive: true });
    await copyFile(
      path.join(INSTALLER_ROOT, "skills", name, "SKILL.md"),
      path.join(root, "skills", name, "SKILL.md"),
    );
  }));

  const cavemanPath = path.join(root, "skills/caveman/SKILL.md");
  const caveman = await readFile(cavemanPath, "utf8");
  await writeFile(cavemanPath, caveman.replace("Respond terse like smart caveman.", "Fixture-only skill body proves isolated payload use."));

  const compressPath = path.join(root, "skills/caveman-compress/SKILL.md");
  const compress = await readFile(compressPath, "utf8");
  await writeFile(compressPath, compress.replace(
    "## Compression Rules",
    "## Compression Rules\n\nFixture-only compression rule.",
  ));
  return root;
}

async function readExpectedSkill(root: string, name: (typeof SKILL_NAMES)[number]): Promise<ExpectedSkill> {
  const skillPath = path.join(root, "skills", name, "SKILL.md");
  const markdown = await readFile(skillPath, "utf8");
  const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)([\s\S]*)$/u.exec(markdown);
  if (!match) throw new Error(`Installed fixture skill "${name}" has invalid frontmatter.`);

  return {
    name,
    path: skillPath,
    content: (match[1] ?? "").replace(/^\r?\n/u, ""),
  };
}

async function setupSkills(installedRoot: string, existing: Map<string, SkillInfo> = new Map()) {
  const added = new Map<string, SkillInfo>();
  let transformCalls = 0;
  const registration: Registration = { dispose: async () => {} };
  const transform = async (
    callback: (editor: SkillEditor) => void,
  ): Promise<Registration> => {
    transformCalls += 1;
    callback({
      get: (id) => existing.get(id),
      add: (skill) => { added.set(skill.id, skill); },
    } as SkillEditor);
    return registration;
  };

  const ctx = { skill: { transform } } as unknown as Pick<Context, "skill">;
  return {
    added,
    registration: await registerCavemanSkills(ctx, installedRoot),
    transformCalls: () => transformCalls,
  };
}

test("registers installed skills using fixture Markdown bodies and absolute asset paths", async () => {
  const root = await createPayload();
  try {
    const { added, registration } = await setupSkills(root);

    expect(registration).toBeDefined();
    expect([...added.keys()].sort()).toEqual([...CAVEMAN_SKILL_NAMES].sort());

    for (const name of SKILL_NAMES) {
      const skill = added.get(name);
      const upstream = await readExpectedSkill(root, name);

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
    expect(added.get("caveman")?.content).toContain("Fixture-only skill body proves isolated payload use.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("leaves colliding skills untouched and adds only missing Caveman skills", async () => {
  const root = await createPayload();
  try {
    const collision = {
      id: "caveman",
      name: "existing caveman",
      description: "Owned by another source.",
      path: "/existing/SKILL.md",
      content: "Do not replace this skill.",
    } as SkillInfo;
    const existing = new Map<string, SkillInfo>([[String(collision.id), collision]]);
    const { added } = await setupSkills(root, existing);

    expect(existing.get("caveman")).toBe(collision);
    expect(added.has("caveman")).toBe(false);
    expect([...added.keys()].sort()).toEqual([...CAVEMAN_SKILL_NAMES].filter((name) => name !== "caveman").sort());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("adapts installed Caveman skills to OpenCode", async () => {
  const root = await createPayload();
  try {
    const { added } = await setupSkills(root);
    for (const name of ["caveman-help", "caveman-compress", "caveman-stats", "cavecrew"]) {
      expect(added.get(name)).toBeDefined();
      expect(path.isAbsolute(String(added.get(name)?.path))).toBe(true);
    }
    expect(added.get("caveman-help")?.content).toContain("Caveman Help (OpenCode)");
    expect(added.get("caveman-help")?.content).not.toContain("Saves ~46%");
    expect(added.get("caveman-compress")?.content).toContain("## Compression Rules");
    expect(added.get("caveman-compress")?.content).toContain("Fixture-only compression rule.");
    expect(added.get("caveman-compress")?.content).not.toContain("python3 -m scripts");
    expect(added.get("caveman-stats")?.content).toContain("unavailable");
    expect(added.get("cavecrew")?.content).toContain("registered by Sherpa at runtime in OpenCode");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("requires the main thread to provide review material to OpenCode cavecrew-reviewer", async () => {
  const root = await createPayload();
  try {
    const { added } = await setupSkills(root);
    const cavecrew = added.get("cavecrew")?.content ?? "";

    expect(cavecrew).toContain("cannot run shell commands or inspect Git state");
    expect(cavecrew).toContain("main thread MUST provide the relevant diff");
    expect(cavecrew).toContain("relevant file excerpts showing the changes");
    expect(cavecrew).toContain("Do not ask it to run `git diff`, `git log`, or `git show`");
    expect(cavecrew).toContain("unless that content was explicitly supplied");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed when an installed skill asset is missing", async () => {
  const root = await createPayload();
  try {
    await rm(path.join(root, "skills/caveman-review/SKILL.md"));
    let calls = 0;
    const context = {
      skill: {
        transform: async () => {
          calls += 1;
          return { dispose: async () => {} };
        },
      },
    };

    await expect(registerCavemanSkills(context as unknown as Pick<Context, "skill">, root)).rejects.toThrow();
    expect(calls).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
