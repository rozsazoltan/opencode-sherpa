import { Plugin } from "@opencode/plugin";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { Registration } from "@opencode/plugin/promise/registration";
import { registerCavecrewAgents } from "./agents.ts";
import { ensureCavemanInstall } from "./caveman-install.ts";
import { registerCavemanMode } from "./caveman-mode.ts";
import { registerCavemanCommands } from "./commands.ts";
import { createEngineeringInstructions } from "./instructions.ts";
import { registerRemoteMcpServers } from "./mcp.ts";
import { registerCavemanSkills } from "./skills.ts";
import { createDirectoryPermissionEvaluator } from "./permissions.ts";
import { syncHostConfig } from "./host-config.ts";

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
    if (ctx.options?.hostSync !== undefined && typeof ctx.options.hostSync !== "boolean") {
      throw new TypeError("hostSync must be a boolean.");
    }
    if (ctx.options?.cavemanInstall !== undefined && typeof ctx.options.cavemanInstall !== "boolean") {
      throw new TypeError("cavemanInstall must be a boolean.");
    }
    const evaluatePermission = createDirectoryPermissionEvaluator(ctx.options);
    const registrations: Registration[] = [];

    try {
      registrations.push(await ctx.session.hook("context", ({ system }) => {
        system.push({ type: "text", text: createEngineeringInstructions(ctx.options?.language) });
      }));
      registrations.push(await ctx.permission.hook("evaluate", evaluatePermission));
      registrations.push(await registerRemoteMcpServers(ctx, ctx.options?.mcp));
      if (ctx.options?.cavemanInstall === true) {
        const installedRoot = await ensureCavemanInstall();
        registrations.push(await registerCavemanSkills(ctx, installedRoot));
        registrations.push(await registerCavecrewAgents(ctx, installedRoot));
        registrations.push(await registerCavemanCommands(ctx, installedRoot));
        registrations.push(await registerCavemanMode(ctx, installedRoot));
      }
    } catch (error) {
      await disposeRegistrations(registrations, true);
      throw error;
    }

    if (ctx.options?.hostSync === true) {
      try {
        await syncHostConfig();
      } catch {
        console.warn("OpenCode Sherpa: optional host config sync failed; runtime registrations remain active.");
      }
    }

    return async () => {
      await disposeRegistrations(registrations);
    };
  },
});

export default SherpaPlugin;
