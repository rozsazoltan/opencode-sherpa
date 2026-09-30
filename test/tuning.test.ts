import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CommandDefinition } from "@opencode/plugin/promise/command";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { SkillEditor } from "@opencode/plugin/promise/skill";
import {
  loadSherpaTuning,
  registerSherpaCommands,
  registerSherpaSkills,
} from "../src/tuning.ts";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "sherpa-tuning-test-"));
  const write = (relative: string, content: string) => {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  return { root, write, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

test("discovers and orders tuning Markdown without an explicit file list", () => {
  const source = fixture();
  try {
    source.write("tuning/instructions/10-style.md", "Style rule.\n");
    source.write("tuning/instructions/02-core.md", "Core rule.\n");
    source.write("tuning/instructions/workflow/01-review.md", "Review rule.\n");
    source.write("tuning/skills/code-review/SKILL.md", [
      "---",
      "name: Code Review",
      "description: Review a change for correctness and missing tests.",
      "metadata:",
      "  opencode/autoinvoke: false",
      "---",
      "Inspect the requested change and report actionable findings.",
    ].join("\n"));
    source.write("tuning/skills/code-review/references/checklist.md", "Supporting file.\n");
    source.write("tuning/skills/team/commit/SKILL.md", [
      "---",
      "description: Prepare a focused commit message.",
      "---",
      "Summarize the staged changes.",
    ].join("\n"));
    source.write("tuning/commands/review.md", [
      "---",
      "description: Review the current changes.",
      "---",
      "Review $ARGUMENTS for correctness and missing tests.",
    ].join("\n"));
    source.write("tuning/commands/git/status.md", "Summarize this repository's status.");
    source.write("tuning/commands/ignored.txt", "Not Markdown.");

    const tuning = loadSherpaTuning(source.root);
    expect(tuning.instructions).toEqual(["Core rule.", "Style rule.", "Review rule."]);
    expect(tuning.skills.map(({ id }) => String(id))).toEqual(["code-review", "team/commit"]);
    expect(tuning.skills[0]).toMatchObject({
      name: "Code Review",
      description: "Review a change for correctness and missing tests.",
      autoinvoke: false,
      content: "Inspect the requested change and report actionable findings.",
    });
    expect(String(tuning.skills[0]?.path)).toBe(path.join(source.root, "tuning/skills/code-review/SKILL.md"));
    expect(tuning.commands).toEqual([
      {
        name: "git/status",
        template: "Summarize this repository's status.",
      },
      {
        name: "review",
        description: "Review the current changes.",
        template: "Review $ARGUMENTS for correctness and missing tests.",
      },
    ]);
  } finally {
    source.dispose();
  }
});

test("sorts Markdown by relative path when file and directory names share a prefix", () => {
  const source = fixture();
  try {
    source.write("tuning/instructions/a/child.md", "Nested rule.\n");
    source.write("tuning/instructions/a.md", "Top-level rule.\n");

    expect(loadSherpaTuning(source.root).instructions).toEqual(["Top-level rule.", "Nested rule."]);
  } finally {
    source.dispose();
  }
});

test("returns empty tuning when content directories do not exist", () => {
  const source = fixture();
  try {
    expect(loadSherpaTuning(source.root)).toEqual({ instructions: [], skills: [], commands: [] });
  } finally {
    source.dispose();
  }
});

test("registers discovered skills and command templates through V2 transforms", async () => {
  const source = fixture();
  const registrations: string[] = [];
  try {
    source.write("tuning/skills/quick/SKILL.md", [
      "---",
      "description: A quick helper skill.",
      "---",
      "Use the quick helper.",
    ].join("\n"));
    source.write("tuning/skills/z-new/SKILL.md", [
      "---",
      "description: A new helper skill.",
      "---",
      "Use the new helper.",
    ].join("\n"));
    source.write("tuning/commands/review.md", [
      "---",
      "description: Review supplied paths.",
      "---",
      "Review $ARGUMENTS carefully. Again: $ARGUMENTS.",
    ].join("\n"));
    source.write("tuning/commands/append.md", "Summarize changes.\n");
    source.write("tuning/commands/literal.md", "Inspect $ARGUMENTS. Keep $1 and ${FILE} literal.\n");

    const tuning = loadSherpaTuning(source.root);
    const existingQuickSkill = { ...tuning.skills[0]!, content: "User-defined quick skill." };
    const skills = new Map<string, Parameters<SkillEditor["add"]>[0]>([["quick", existingQuickSkill]]);
    const skillContext = {
      skill: {
        transform: async (callback: (editor: SkillEditor) => void) => {
          callback({
            get: (id) => skills.get(id) as ReturnType<SkillEditor["get"]>,
            add: (skill) => { skills.set(skill.id, skill); },
          } as SkillEditor);
          return { dispose: async () => { registrations.push("skills"); } };
        },
      },
    } as unknown as Pick<Context, "skill">;

    const commands = new Map<string, CommandDefinition>();
    const prompts: unknown[] = [];
    const commandContext = {
      command: {
        transform: async (callback: (editor: { add: (definition: CommandDefinition) => void }) => void) => {
          callback({ add: (definition) => { commands.set(definition.name, definition); } });
          return { dispose: async () => { registrations.push("commands"); } };
        },
      },
      session: {
        prompt: async (input: unknown) => { prompts.push(input); },
      },
    } as unknown as Pick<Context, "command" | "session">;

    const skillRegistration = await registerSherpaSkills(skillContext, tuning.skills);
    const commandRegistration = await registerSherpaCommands(commandContext, tuning.commands);
    expect([...skills.keys()]).toEqual(["quick", "z-new"]);
    expect(skills.get("quick")?.content).toBe("User-defined quick skill.");
    expect([...commands.keys()]).toEqual(["append", "literal", "review"]);

    const executeCommand = async (
      name: string,
      prompt: Parameters<CommandDefinition["execute"]>[0]["prompt"],
    ) => {
      await commands.get(name)!.execute({
        sessionID: "session-id" as Parameters<CommandDefinition["execute"]>[0]["sessionID"],
        prompt,
        delivery: "queue",
      });
      return prompts[prompts.length - 1];
    };

    const reviewPrompt = await executeCommand("review", {
      text: "src/auth.ts",
      files: [{
        uri: "file:///src/auth.ts",
        name: "auth.ts",
        description: "Source file",
        mention: { start: 0, end: 11, text: "src/auth.ts" },
      }],
      agents: [{ name: "reviewer", mention: { start: 0, end: 9, text: "@reviewer" } }],
      skills: [{ id: tuning.skills[0]!.id, mention: { start: 0, end: 12, text: "$quick" } }],
    });
    expect(reviewPrompt).toEqual({
      sessionID: "session-id",
      text: "Review src/auth.ts carefully. Again: src/auth.ts.",
      delivery: "queue",
      files: [{ uri: "file:///src/auth.ts", name: "auth.ts", description: "Source file" }],
      agents: [{ name: "reviewer" }],
      skills: [{ id: tuning.skills[0]!.id }],
    });

    await executeCommand("append", { text: "src/a.ts" });
    expect(prompts[1]).toMatchObject({ text: "Summarize changes.\n\nsrc/a.ts" });

    await executeCommand("append", { text: " \t " });
    expect(prompts[2]).toMatchObject({ text: "Summarize changes." });

    await executeCommand("literal", { text: "" });
    expect(prompts[3]).toMatchObject({ text: "Inspect . Keep $1 and ${FILE} literal." });

    await executeCommand("literal", { text: "src/a.ts" });
    expect(prompts[4]).toMatchObject({ text: "Inspect src/a.ts. Keep $1 and ${FILE} literal." });
    await executeCommand("literal", { text: "$& $$ $` $'" });
    expect(prompts[5]).toMatchObject({ text: "Inspect $& $$ $` $'. Keep $1 and ${FILE} literal." });

    await skillRegistration?.dispose();
    await commandRegistration?.dispose();
    expect(registrations).toEqual(["skills", "commands"]);
  } finally {
    source.dispose();
  }
});

test("rejects skills with missing descriptions and malformed frontmatter", () => {
  const source = fixture();
  try {
    source.write("tuning/skills/missing-description/SKILL.md", "---\nname: Missing\n---\nBody.\n");
    expect(() => loadSherpaTuning(source.root)).toThrow("Skills require a description");

    rmSync(path.join(source.root, "tuning/skills"), { recursive: true, force: true });
    source.write("tuning/commands/broken.md", "---\ndescription: [unterminated\n---\nBody.\n");
    expect(() => loadSherpaTuning(source.root)).toThrow("Markdown frontmatter is invalid");
  } finally {
    source.dispose();
  }
});

test("rejects command frontmatter without a closing delimiter", () => {
  const source = fixture();
  try {
    source.write("tuning/commands/unclosed.md", "---\ndescription: Review changes.\nReview $ARGUMENTS.\n");
    expect(() => loadSherpaTuning(source.root)).toThrow("Markdown frontmatter is invalid");
  } finally {
    source.dispose();
  }
});

test("rejects packaged commands whose derived names collide", () => {
  const source = fixture();
  try {
    const commandDirectory = path.join(source.root, "tuning/commands");
    source.write("tuning/commands/review.md", "Review changes.\n");
    source.write("tuning/commands/review.MD", "Review changes again.\n");
    const filenames = readdirSync(commandDirectory);
    if (!filenames.includes("review.md") || !filenames.includes("review.MD")) return;

    expect(() => loadSherpaTuning(source.root)).toThrow("Duplicate packaged command name 'review'");
  } finally {
    source.dispose();
  }
});

test("skips empty skill and command transforms", async () => {
  const transform = () => {
    throw new Error("Empty transform must not register.");
  };
  const context = {
    skill: { transform },
    command: { transform },
  } as unknown as Pick<Context, "skill" | "command">;

  expect(await registerSherpaSkills(context, [])).toBeUndefined();
  expect(await registerSherpaCommands(context as Pick<Context, "command" | "session">, [])).toBeUndefined();
});

test("does not follow symbolic links while scanning tuning files", () => {
  const source = fixture();
  try {
    source.write("outside.md", "Must not be injected.\n");
    mkdirSync(path.join(source.root, "tuning/instructions"), { recursive: true });
    const link = path.join(source.root, "tuning/instructions/linked.md");
    try {
      symlinkSync(path.join(source.root, "outside.md"), link);
    } catch (error) {
      if (isKnownSymlinkRestriction(error)) return;
      throw error;
    }
    const tuning = loadSherpaTuning(source.root);
    expect(tuning.instructions).toEqual([]);
    expect(readFileSync(path.join(source.root, "outside.md"), "utf8")).toBe("Must not be injected.\n");
  } finally {
    source.dispose();
  }
});

test("does not traverse a symbolic tuning root", () => {
  const source = fixture();
  try {
    source.write("outside/instructions/private.md", "Must not be injected.\n");
    try {
      symlinkSync(path.join(source.root, "outside"), path.join(source.root, "tuning"), "dir");
    } catch (error) {
      if (isKnownSymlinkRestriction(error)) return;
      throw error;
    }
    expect(() => loadSherpaTuning(source.root)).toThrow("Tuning content path must be a real directory");
  } finally {
    source.dispose();
  }
});

function isKnownSymlinkRestriction(error: unknown): boolean {
  return error instanceof Error && "code" in error &&
    ["EACCES", "EPERM", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"].includes(String(error.code));
}
