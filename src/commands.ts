import type { CommandDefinition } from "@opencode/plugin/promise/command";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { Registration } from "@opencode/plugin/promise/registration";

const CAVEMAN_COMMANDS = [
  {
    name: "caveman",
    description: "Switch Caveman mode for this session",
    template: "Apply the caveman skill with level '$ARGUMENTS' (default full, off disables it).",
  },
  {
    name: "caveman-commit",
    description: "Draft a concise Conventional Commit message",
    template: "Use the caveman-commit skill for this request: $ARGUMENTS",
  },
  {
    name: "caveman-review",
    description: "Review changes in concise Caveman format",
    template: "Use the caveman-review skill to review: $ARGUMENTS",
  },
  {
    name: "caveman-help",
    description: "Show the Caveman quick reference",
    template: "Use the caveman-help skill to show the OpenCode Caveman reference.",
  },
  {
    name: "caveman-stats",
    description: "Report available session usage without guessed savings",
    template: "Use the caveman-stats skill. Report only measured OpenCode session usage, if available.",
  },
  {
    name: "caveman-compress",
    description: "Compress prose in a natural-language file",
    template: "Use the caveman-compress skill for this file: $ARGUMENTS. Confirm a safe backup before editing.",
  },
] as const;

function createCommand(ctx: Pick<Context, "session">, definition: (typeof CAVEMAN_COMMANDS)[number]): CommandDefinition {
  return {
    name: definition.name,
    description: definition.description,
    execute: async (input) => {
      const { files, agents, skills, ...prompt } = input.prompt;
      await ctx.session.prompt({
        ...prompt,
        sessionID: input.sessionID,
        text: definition.template.replaceAll("$ARGUMENTS", prompt.text),
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
): Promise<Registration> {
  const existing = await ctx.command.list();
  const existingNames = new Set(existing.data.map(({ name }) => name));
  const definitions = CAVEMAN_COMMANDS.map((definition) => createCommand(ctx, definition));

  // V2.0.16 command.add is a Map.set, so skip names already visible in the list.
  // This snapshot cannot prevent a later transform from replacing a command.
  return ctx.command.transform((editor) => {
    for (const definition of definitions) {
      if (existingNames.has(definition.name)) continue;
      editor.add(definition);
    }
  });
}
