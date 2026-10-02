#!/usr/bin/env node

if (!process.versions.bun) {
  const { registerHooks, stripTypeScriptTypes } = await import("node:module");
  const { readFileSync } = await import("node:fs");
  const sourcePrefix = new URL("../src/", import.meta.url).href;

  registerHooks({
    load(url, context, nextLoad) {
      if (!url.startsWith(sourcePrefix) || !url.endsWith(".ts")) return nextLoad(url, context);

      return {
        format: "module",
        source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), { mode: "strip", sourceUrl: url }),
        shortCircuit: true,
      };
    },
  });
}

const { runCli } = await import("../src/cli.ts");
process.exitCode = await runCli(process.argv.slice(2));
