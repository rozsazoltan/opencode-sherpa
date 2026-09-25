import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandDefinition, CommandEditor, CommandInvocation } from "@opencode/plugin/promise/command";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { Registration } from "@opencode/plugin/promise/registration";
import type { ID as SkillID } from "@opencode/schema/skill";
import { registerCavemanCommands } from "../src/commands.ts";

const COMMANDS = [
  "caveman",
  "caveman-commit",
  "caveman-review",
  "caveman-help",
  "caveman-stats",
  "caveman-compress",
] as const;
const INSTALLER_ROOT = fileURLToPath(new URL("../node_modules/caveman-installer/", import.meta.url));
const OPENCODE_COMPRESSION_BACKUP_INSTRUCTION =
  "Before overwriting, create a readable backup outside the repository and every skill directory (under the host's data directory). Use a distinct backup path for each original file and never overwrite an existing backup. If a safe backup cannot be made, leave the original untouched.";

async function createPayload(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-sherpa-commands-"));
  await Promise.all([
    mkdir(path.join(root, "agents"), { recursive: true }),
    mkdir(path.join(root, "commands"), { recursive: true }),
    mkdir(path.join(root, "skills"), { recursive: true }),
    mkdir(path.join(root, "plugins/caveman"), { recursive: true }),
  ]);
  await writeFile(path.join(root, "AGENTS.md"), "# Isolated installer fixture\n");
  for (const name of COMMANDS) {
    await copyFile(
      path.join(INSTALLER_ROOT, "src/plugins/opencode/commands", `${name}.md`),
      path.join(root, "commands", `${name}.md`),
    );
  }

  const commitPath = path.join(root, "commands/caveman-commit.md");
  const commit = await readFile(commitPath, "utf8");
  await writeFile(commitPath, commit.replace(
    "Generate a commit message for the current staged changes.",
    "Fixture commit prompt: $ARGUMENTS",
  ));
  const helpPath = path.join(root, "commands/caveman-help.md");
  const help = await readFile(helpPath, "utf8");
  await writeFile(helpPath, help.replace(
    /^description: .*$/mu,
    "description: 'Installer-normalized help description'",
  ));
  return root;
}

async function expectedCommandBody(root: string, name: (typeof COMMANDS)[number]): Promise<string> {
  const markdown = await readFile(path.join(root, "commands", `${name}.md`), "utf8");
  const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)([\s\S]*)$/u.exec(markdown);
  if (!match) throw new Error(`Fixture command "${name}" has invalid frontmatter.`);
  const body = (match[1] ?? "").replace(/^\r?\n/u, "");
  if (name !== "caveman-compress") return body;

  const upstreamBackupInstruction = /Original is backed up as `<file>\.original\.md` before\s+overwrite\./u;
  if (!upstreamBackupInstruction.test(body)) {
    throw new Error("Fixture compression command has unsupported backup instructions.");
  }
  return body.replace(upstreamBackupInstruction, OPENCODE_COMPRESSION_BACKUP_INSTRUCTION);
}

async function setupCommands(installedRoot: string, existingNames: string[] = []) {
  const existing = new Map<string, CommandDefinition>(existingNames.map((name) => [name, {
    name,
    description: "Pre-existing command",
    execute: async () => {},
  }]));
  const added = new Map<string, CommandDefinition>();
  const attemptedNames: string[] = [];
  const prompts: Array<Parameters<Context["session"]["prompt"]>[0]> = [];
  let disposed = false;
  let listCalls = 0;
  let transformCalls = 0;
  const context = {
    command: {
      list: async () => {
        listCalls += 1;
        return { data: existingNames.map((name) => ({ name })) };
      },
      transform: async (callback: (editor: CommandEditor) => void): Promise<Registration> => {
        transformCalls += 1;
        callback({
          add: (definition) => {
            attemptedNames.push(definition.name);
            existing.set(definition.name, definition);
            added.set(definition.name, definition);
          },
        } as CommandEditor);
        return { dispose: async () => { disposed = true; } };
      },
    },
    session: {
      prompt: async (input: Parameters<Context["session"]["prompt"]>[0]) => { prompts.push(input); },
    },
  } as unknown as Pick<Context, "command" | "session">;

  return {
    added,
    existing,
    attemptedNames,
    prompts,
    listCalls: () => listCalls,
    transformCalls: () => transformCalls,
    registration: await registerCavemanCommands(context, installedRoot),
    wasDisposed: () => disposed,
  };
}

test("registers commands from installed Markdown and forwards templated prompts with attachments", async () => {
  const root = await createPayload();
  try {
    const result = await setupCommands(root);
    expect([...result.added.keys()].sort()).toEqual([...COMMANDS].sort());
    expect(result.added.get("caveman-help")?.description).toBe("Installer-normalized help description");

    const invocation: CommandInvocation = {
      sessionID: "session-123" as CommandInvocation["sessionID"],
      prompt: {
        text: "review the attached change",
        files: [{
          uri: "file:///workspace/change.diff",
          name: "change.diff",
          description: "Review attachment",
          mention: { start: 0, end: 8, text: "@change" },
        }],
        agents: [{ name: "cavecrew-reviewer", mention: { start: 0, end: 9, text: "@reviewer" } }],
        skills: [{ id: "caveman-review" as SkillID, mention: { start: 10, end: 20, text: "@caveman-review" } }],
      },
      delivery: "queue",
    };

    for (const [name, definition] of result.added) {
      expect(definition.description).toBeTruthy();
      await definition.execute(invocation);
      const body = await expectedCommandBody(root, name as (typeof COMMANDS)[number]);
      expect(result.prompts.at(-1)).toEqual({
        sessionID: invocation.sessionID,
        text: body.replaceAll("$ARGUMENTS", () => invocation.prompt.text),
        delivery: "queue",
        files: [{
          uri: "file:///workspace/change.diff",
          name: "change.diff",
          description: "Review attachment",
          mention: { start: 0, end: 8, text: "@change" },
        }],
        agents: [{ name: "cavecrew-reviewer", mention: { start: 0, end: 9, text: "@reviewer" } }],
        skills: [{ id: "caveman-review" as SkillID, mention: { start: 10, end: 20, text: "@caveman-review" } }],
      });
    }
    expect(result.prompts).toHaveLength(COMMANDS.length);
    expect(result.prompts.find(({ text }) => text.startsWith("Activate caveman mode:"))?.text)
      .toStartWith("Activate caveman mode: review the attached change");
    expect(result.prompts.find(({ text }) => text.startsWith("Fixture commit prompt:"))?.text)
      .toStartWith("Fixture commit prompt: review the attached change");
    const compressionPrompt = result.prompts.find(({ text }) => text.startsWith("Compress the file at:"))?.text;
    expect(compressionPrompt).toContain("backup outside the repository and every skill directory");
    expect(compressionPrompt).not.toContain("Original is backed up as `<file>.original.md`");

    await result.registration.dispose();
    expect(result.wasDisposed()).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("forwards JavaScript replacement tokens in command arguments literally", async () => {
  const root = await createPayload();
  try {
    const result = await setupCommands(root);
    const definition = result.added.get("caveman-commit");
    if (!definition) throw new Error("The installed Caveman commit command was not registered.");

    const argumentText = ["$&", "$'", "$`", "$$"].join(" | ");
    const invocation: CommandInvocation = {
      sessionID: "session-456" as CommandInvocation["sessionID"],
      prompt: { text: argumentText },
      delivery: "queue",
    };

    await definition.execute(invocation);

    const body = await expectedCommandBody(root, "caveman-commit");
    expect(result.prompts.at(-1)?.text).toBe(body.replaceAll("$ARGUMENTS", () => argumentText));
    expect(result.prompts.at(-1)?.text).toStartWith(`Fixture commit prompt: ${argumentText}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("never attempts to add names already returned by the host command list", async () => {
  const root = await createPayload();
  try {
    const result = await setupCommands(root, ["caveman", "user-command"]);

    expect(result.added.has("caveman")).toBe(false);
    expect(result.attemptedNames).not.toContain("caveman");
    expect(result.existing.get("caveman")?.description).toBe("Pre-existing command");
    expect([...result.added.keys()].sort()).toEqual(COMMANDS.filter((name) => name !== "caveman").sort());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed when an installed command asset is missing", async () => {
  const root = await createPayload();
  try {
    await rm(path.join(root, "commands/caveman-help.md"));
    let listCalls = 0;
    let transformCalls = 0;
    const context = {
      command: {
        list: async () => {
          listCalls += 1;
          return { data: [] };
        },
        transform: async () => {
          transformCalls += 1;
          return { dispose: async () => {} };
        },
      },
      session: { prompt: async () => {} },
    };

    await expect(registerCavemanCommands(context as unknown as Pick<Context, "command" | "session">, root))
      .rejects.toThrow();
    expect(listCalls).toBe(0);
    expect(transformCalls).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
