import { Plugin } from "@opencode/plugin";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { Registration } from "@opencode/plugin/promise/registration";
import { createEngineeringInstructions } from "./instructions.ts";
import { registerRemoteMcpServers } from "./mcp.ts";
import {
  configuredSherpaAgentSources,
  resolveSherpaAgentSources,
} from "./agent-sources.ts";
import { syncSherpaOmoAgents } from "./omo-agents.ts";
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
    const agentSources = configuredSherpaAgentSources(ctx.options?.agentSources);
    const agentResolution = await resolveSherpaAgentSources(agentSources);
    const evaluatePermission = createDirectoryPermissionEvaluator(ctx.options);
    const registrations: Registration[] = [];

    try {
      if (agentResolution.diagnostics.length > 0) {
        for (const diagnostic of agentResolution.diagnostics) {
          console.warn(`OpenCode Sherpa: agent source ${diagnostic.namespace}: ${diagnostic.message}`);
        }
      }
      const agentSync = agentResolution.agents.length > 0
        ? syncSherpaOmoAgents(agentResolution.agents, { sources: agentResolution.sources })
        : undefined;
      if (agentSync && agentSync.diagnostics.length > 0) {
        const ids = agentSync.collisions.map(({ id }) => id).join(", ");
        console.warn(`OpenCode Sherpa: skipped conflicting OMO-Slim agent files: ${ids}.`);
      }
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
