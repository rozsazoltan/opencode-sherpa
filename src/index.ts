import { Plugin } from "@opencode/plugin";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { Registration } from "@opencode/plugin/promise/registration";
import { createEngineeringInstructions } from "./instructions.ts";
import { registerRemoteMcpServers } from "./mcp.ts";
import { createDirectoryPermissionEvaluator } from "./permissions.ts";
import { loadSherpaTuning, registerSherpaCommands, registerSherpaSkills } from "./tuning.ts";

async function disposeRegistrations(
  registrations: readonly Registration[],
  suppressErrors = false,
): Promise<void> {
  let firstError: unknown;
  let hasError = false;

  for (const registration of [...registrations].reverse()) {
    try {
      await registration.dispose();
    } catch (error) {
      if (!hasError) {
        firstError = error;
        hasError = true;
      }
    }
  }

  if (hasError && !suppressErrors) throw firstError;
}

export const SherpaPlugin = Plugin.define({
  id: "opencode-sherpa",
  async setup(ctx: Context) {
    const tuning = loadSherpaTuning();
    const evaluatePermission = createDirectoryPermissionEvaluator(ctx.options);
    const registrations: Registration[] = [];

    try {
      registrations.push(await ctx.session.hook("context", ({ system }) => {
        const text = [createEngineeringInstructions(ctx.options?.language), ...tuning.instructions]
          .filter((instruction) => instruction.length > 0)
          .join("\n\n");
        system.push({ type: "text", text });
      }));
      registrations.push(await ctx.permission.hook("evaluate", evaluatePermission));
      registrations.push(await registerRemoteMcpServers(ctx, ctx.options?.mcp));
      const skillRegistration = await registerSherpaSkills(ctx, tuning.skills);
      if (skillRegistration) registrations.push(skillRegistration);
      const commandRegistration = await registerSherpaCommands(ctx, tuning.commands);
      if (commandRegistration) registrations.push(commandRegistration);
    } catch (error) {
      await disposeRegistrations(registrations, true);
      throw error;
    }

    return async () => {
      await disposeRegistrations(registrations);
    };
  },
});

export default SherpaPlugin;
