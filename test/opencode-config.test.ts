import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultOpenCodeConfigDirectory, readGlobalMcpServerNames } from "../src/opencode-config.ts";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "sherpa-opencode-config-test-"));
  return {
    root,
    write(relative: string, contents: string) {
      const target = path.join(root, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, contents);
      return target;
    },
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("resolves OpenCode config directory from absolute XDG path or home fallback", () => {
  expect(defaultOpenCodeConfigDirectory({
    homeDirectory: "/tmp/sherpa-home",
    env: { XDG_CONFIG_HOME: "/tmp/sherpa-xdg" },
  })).toBe("/tmp/sherpa-xdg/opencode");
  expect(defaultOpenCodeConfigDirectory({
    homeDirectory: "/tmp/sherpa-home",
    env: { XDG_CONFIG_HOME: "relative-xdg" },
  })).toBe("/tmp/sherpa-home/.config/opencode");
  expect(defaultOpenCodeConfigDirectory({
    homeDirectory: "/tmp/sherpa-home",
    env: {},
  })).toBe("/tmp/sherpa-home/.config/opencode");
  expect(path.isAbsolute(defaultOpenCodeConfigDirectory({
    homeDirectory: "relative-home",
    env: {},
  }))).toBe(true);
});

test("reads only sorted global MCP server names and leaves credentials untouched", () => {
  const data = fixture();
  const contents = `{
    // This value must remain private to config readers.
    "mcp": { "servers": {
      "zeta": false,
      "github": { "enabled": false, "headers": { "Authorization": "sentinel-secret-value" } },
      "alpha": { "type": "remote" }
    } }
  }\n`;
  try {
    const file = data.write("config/opencode.jsonc", contents);
    const names = readGlobalMcpServerNames(path.join(data.root, "config"));
    expect(names).toEqual(["alpha", "github", "zeta"]);
    expect(JSON.stringify(names)).not.toContain("sentinel-secret-value");
    expect(readFileSync(file, "utf8")).toBe(contents);
    expect(readGlobalMcpServerNames(path.join(data.root, "missing"))).toEqual([]);
    expect(readGlobalMcpServerNames(path.join(data.root, "empty"))).toEqual([]);
  } finally {
    data.dispose();
  }
});

test("rejects relative directories, config pairs, malformed files, and invalid MCP shapes", () => {
  expect(() => readGlobalMcpServerNames("relative/config")).toThrow("absolute path");
  const data = fixture();
  const configDirectory = path.join(data.root, "config");
  try {
    data.write("config/opencode.json", "{}\n");
    data.write("config/opencode.jsonc", "{}\n");
    expect(() => readGlobalMcpServerNames(configDirectory)).toThrow("Multiple global OpenCode config files");

    rmSync(path.join(configDirectory, "opencode.jsonc"));
    for (const contents of [
      "{ invalid\n",
      "[]\n",
      '{"mcp": false}\n',
      '{"mcp":{"servers":[]}}\n',
    ]) {
      writeFileSync(path.join(configDirectory, "opencode.json"), contents);
      expect(() => readGlobalMcpServerNames(configDirectory)).toThrow();
    }
  } finally {
    data.dispose();
  }
});
