import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSherpaTuning } from "../src/tuning.ts";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "sherpa-tuning-test-"));
  const write = (relative: string, content: string) => {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  return { root, write, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

test("discovers and orders project instructions, skills, and command Markdown", () => {
  const source = fixture();
  try {
    source.write("tuning/instructions/10-style.md", "Style rule.\n");
    source.write("tuning/instructions/guides/02-core.MD", "Core rule.\n");
    source.write("tuning/skills/code-review/SKILL.md", [
      "---",
      "name: Code Review",
      "description: Review a change for correctness and missing tests.",
      "metadata:",
      "  opencode/autoinvoke: false",
      "---",
      "Inspect the requested change.",
    ].join("\n"));
    source.write("tuning/skills/code-review/references/checklist.md", "Supporting file.\n");
    source.write("tuning/commands/git/status.md", "Summarize repository status.\n");

    const tuning = loadSherpaTuning(source.root);
    expect(tuning.instructions).toEqual([
      {
        id: "10-style",
        path: path.join(source.root, "tuning/instructions/10-style.md"),
        content: "Style rule.\n",
      },
      {
        id: "guides/02-core",
        path: path.join(source.root, "tuning/instructions/guides/02-core.MD"),
        content: "Core rule.\n",
      },
    ]);
    expect(tuning.skills).toMatchObject([{
      id: "code-review",
      name: "Code Review",
      description: "Review a change for correctness and missing tests.",
      autoinvoke: false,
      content: "Inspect the requested change.",
    }]);
    expect(tuning.skills[0]?.path).toBe(path.join(source.root, "tuning/skills/code-review/SKILL.md"));
    expect(tuning.commands).toEqual([{
      name: "git/status",
      template: "Summarize repository status.",
      path: path.join(source.root, "tuning/commands/git/status.md"),
    }]);
    expect(readFileSync(path.join(source.root, "tuning/skills/code-review/references/checklist.md"), "utf8"))
      .toBe("Supporting file.\n");
  } finally {
    source.dispose();
  }
});

test("rejects missing skill descriptions and does not follow linked tuning files", () => {
  const source = fixture();
  try {
    source.write("tuning/skills/missing/SKILL.md", "---\nname: Missing\n---\nBody.\n");
    expect(() => loadSherpaTuning(source.root)).toThrow("Skills require a description");

    rmSync(path.join(source.root, "tuning/skills"), { recursive: true, force: true });
    source.write("outside.md", "Must not be loaded.\n");
    mkdirSync(path.join(source.root, "tuning/instructions"), { recursive: true });
    try {
      symlinkSync(path.join(source.root, "outside.md"), path.join(source.root, "tuning/instructions/linked.md"));
    } catch (error) {
      if (error instanceof Error && "code" in error && ["EACCES", "EPERM", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"].includes(String(error.code))) return;
      throw error;
    }
    expect(loadSherpaTuning(source.root).instructions).toEqual([]);
  } finally {
    source.dispose();
  }
});

test("skips blank instructions and rejects duplicate or unsafe instruction IDs", () => {
  const source = fixture();
  try {
    source.write("tuning/instructions/blank.md", " \n\t");
    expect(loadSherpaTuning(source.root).instructions).toEqual([]);

    source.write("tuning/instructions/nested/rule.md", "Rule.\n");
    source.write("tuning/instructions/nested/rule.MD", "Duplicate.\n");
    expect(() => loadSherpaTuning(source.root)).toThrow("Duplicate packaged instruction ID 'nested/rule'");

    rmSync(path.join(source.root, "tuning/instructions"), { recursive: true, force: true });
    source.write("tuning/instructions/Uppercase-name.md", "Unsafe ID.\n");
    expect(() => loadSherpaTuning(source.root)).toThrow("Invalid tuning content name");
  } finally {
    source.dispose();
  }
});
