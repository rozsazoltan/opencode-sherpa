import { Plugin } from "@opencode/plugin";
import type { Context } from "@opencode/plugin/promise/plugin";
import { createEngineeringInstructions } from "./instructions.ts";
import { createDirectoryPermissionEvaluator } from "./permissions.ts";

export const SherpaPlugin = Plugin.define({
  id: "opencode-sherpa",
  async setup(ctx: Context) {
    const evaluatePermission = createDirectoryPermissionEvaluator(ctx.options);
    const registrations = await Promise.all([
      ctx.session.hook("context", ({ system }) => {
        system.push({ type: "text", text: createEngineeringInstructions(ctx.options?.language) });
      }),
      ctx.permission.hook("evaluate", evaluatePermission),
    ]);

    return async () => {
      await Promise.all(registrations.map((registration) => registration.dispose()));
    };
  },
});

export default SherpaPlugin;
