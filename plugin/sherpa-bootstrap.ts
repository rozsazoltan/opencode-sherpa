import { Plugin } from "@opencode/plugin";
import { registerSherpaBootstrap, type BootstrapPluginContext } from "./bootstrap.ts";

// Targets documented OpenCode Plugin API V2. The repository's pinned @opencode-ai/plugin source is V1;
// this global-only integration is not runtime-verified against that older package.
export default Plugin.define({
  id: "sherpa-global-bootstrap",
  async setup(ctx) {
    registerSherpaBootstrap(ctx as unknown as BootstrapPluginContext);
  },
});
