import { expect, test } from "bun:test";
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

async function setupCommands(existingNames: string[] = []) {
  const existing = new Map<string, CommandDefinition>(existingNames.map((name) => [name, {
    name,
    description: "Pre-existing command",
    execute: async () => {},
  }]));
  const added = new Map<string, CommandDefinition>();
  const attemptedNames: string[] = [];
  const prompts: Array<Parameters<Context["session"]["prompt"]>[0]> = [];
  let disposed = false;
  const context = {
    command: {
      list: async () => ({ data: existingNames.map((name) => ({ name })) }),
      transform: async (callback: (editor: CommandEditor) => void): Promise<Registration> => {
        callback({
          add: (definition) => {
            attemptedNames.push(definition.name);
            existing.set(definition.name, definition);
            added.set(definition.name, definition);
          },
        });
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
    registration: await registerCavemanCommands(context),
    wasDisposed: () => disposed,
  };
}

test("registers six Caveman commands and forwards templated prompts with attachments", async () => {
  const result = await setupCommands();
  expect([...result.added.keys()].sort()).toEqual([...COMMANDS].sort());

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
    expect(result.prompts.at(-1)).toEqual({
      sessionID: invocation.sessionID,
      text: name === "caveman"
        ? "Apply the caveman skill with level 'review the attached change' (default full, off disables it)."
        : name === "caveman-commit"
          ? "Use the caveman-commit skill for this request: review the attached change"
          : name === "caveman-review"
            ? "Use the caveman-review skill to review: review the attached change"
            : name === "caveman-help"
              ? "Use the caveman-help skill to show the OpenCode Caveman reference."
              : name === "caveman-stats"
                ? "Use the caveman-stats skill. Report only measured OpenCode session usage, if available."
                : "Use the caveman-compress skill for this file: review the attached change. Confirm a safe backup before editing.",
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

  await result.registration.dispose();
  expect(result.wasDisposed()).toBe(true);
});

test("never attempts to add names already returned by the host command list", async () => {
  const result = await setupCommands(["caveman", "user-command"]);

  expect(result.added.has("caveman")).toBe(false);
  expect(result.attemptedNames).not.toContain("caveman");
  expect(result.existing.get("caveman")?.description).toBe("Pre-existing command");
  expect([...result.added.keys()].sort()).toEqual(COMMANDS.filter((name) => name !== "caveman").sort());
});
