import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "jsonc-parser";
import { syncHostConfig } from "../src/host-config.ts";

const SLIM = "oh-my-opencode-slim@2";
const DCP = "@tarquinen/opencode-dcp@3";
const PLAYWRIGHT = "opencode-playwright@git+https://github.com/rozsazoltan/opencode-playwright.git#f06567970c9b10ec845c0b8aa1df816d2e6f7333";

function fixture(config: string, name = "opencode.jsonc") {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sherpa-host-test-"));
  const configFile = path.join(directory, name);
  writeFileSync(configFile, config);
  return {
    directory,
    configFile,
    read: () => parse(readFileSync(configFile, "utf8")) as Record<string, any>,
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function stateText(state: unknown): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

function legacyState() {
  return {
    version: 1,
    plugins: [SLIM, DCP],
    agents: {
      "sherpa-owned": { description: "unchanged agent" },
      "sherpa-edited": { description: "old agent" },
    },
    commands: {
      "sherpa-owned": { template: "unchanged command" },
      "sherpa-edited": { template: "old command" },
    },
  };
}

test("adds only external plugins to a clean host config and records v2 ownership", async () => {
  const host = fixture('{\n  "$schema": "https://opencode.ai/config.json"\n}\n');
  try {
    expect(await syncHostConfig(host.directory, false)).toBe(true);
    const config = host.read();
    expect(config.plugins).toEqual([SLIM, DCP]);
    expect(config.agents).toBeUndefined();
    expect(config.commands).toBeUndefined();
    const ownership = JSON.parse(readFileSync(path.join(host.directory, ".sherpa-owned.json"), "utf8"));
    expect(ownership).toEqual({ version: 2, plugins: [SLIM, DCP] });
    const first = readFileSync(host.configFile, "utf8");
    expect(await syncHostConfig(host.directory, false)).toBe(false);
    expect(readFileSync(host.configFile, "utf8")).toBe(first);
  } finally {
    host.dispose();
  }
});

test("preserves comments, secrets, and existing user-owned names", async () => {
  const original = `{
    // Do not touch credentials or overrides
    "mcp": {"github": {"headers": {"Authorization": "private-test-value"}}},
    "plugins": ["other-plugin", {"package":"oh-my-opencode-slim@1","options":{"custom":true}}],
    "agents": {"cavecrew-builder": {"description":"my agent"}},
    "commands": {"caveman": {"template":"my command"}},
  }\n`;
  const host = fixture(original);
  try {
    expect(await syncHostConfig(host.directory, true)).toBe(true);
    const raw = readFileSync(host.configFile, "utf8");
    expect(raw).toContain("// Do not touch credentials or overrides");
    const config = host.read();
    expect(config.mcp.github.headers.Authorization).toBe("private-test-value");
    expect(config.plugins[0]).toBe("other-plugin");
    expect(config.plugins[1]).toEqual({ package: "oh-my-opencode-slim@1", options: { custom: true } });
    expect(config.plugins).toContain(DCP);
    expect(config.plugins.some((item: string) => typeof item === "string" && item.startsWith("opencode-playwright@git+"))).toBe(true);
    expect(config.plugins.filter((item: unknown) =>
      (typeof item === "string" ? item : item && typeof item === "object" ? (item as any).package : "")
        .toString().startsWith("oh-my-opencode-slim@"))).toHaveLength(1);
    const ownership = JSON.parse(readFileSync(path.join(host.directory, ".sherpa-owned.json"), "utf8"));
    expect(ownership.plugins).not.toContain(SLIM);
    expect(config.agents["cavecrew-builder"]).toEqual({ description: "my agent" });
    expect(config.commands.caveman).toEqual({ template: "my command" });
    expect(await syncHostConfig(host.directory, true)).toBe(false);
  } finally {
    host.dispose();
  }
});

test("updates an unchanged owned selector but preserves a user-edited selector without adopting it", async () => {
  const host = fixture("{}\n", "opencode.json");
  try {
    await syncHostConfig(host.directory, false);
    const ownedFile = path.join(host.directory, ".sherpa-owned.json");
    const state = JSON.parse(readFileSync(ownedFile, "utf8"));
    state.plugins[0] = "oh-my-opencode-slim@1";
    const config = host.read();
    config.plugins[0] = "oh-my-opencode-slim@1";
    config.plugins[1] = "@tarquinen/opencode-dcp@user-edited";
    writeFileSync(host.configFile, JSON.stringify(config, null, 2));
    writeFileSync(ownedFile, JSON.stringify(state));
    expect(await syncHostConfig(host.directory, false)).toBe(true);
    const updated = host.read();
    expect(updated.plugins).toEqual([SLIM, "@tarquinen/opencode-dcp@user-edited"]);
    expect(JSON.parse(readFileSync(ownedFile, "utf8")).plugins).toEqual([SLIM]);
  } finally {
    host.dispose();
  }
});

test("does not duplicate a preexisting object selector while updating an owned plugin", async () => {
  const host = fixture(JSON.stringify({
    plugins: ["oh-my-opencode-slim@1", { package: SLIM, options: { user: true } }, DCP],
  }, null, 2) + "\n");
  try {
    const stateFile = path.join(host.directory, ".sherpa-owned.json");
    writeFileSync(stateFile, stateText({ version: 2, plugins: ["oh-my-opencode-slim@1", DCP] }));
    expect(await syncHostConfig(host.directory, false)).toBe(true);
    expect(host.read().plugins).toEqual([{ package: SLIM, options: { user: true } }, DCP]);
    expect(JSON.parse(readFileSync(stateFile, "utf8")).plugins).toEqual([DCP]);
  } finally {
    host.dispose();
  }
});

test("preserves comments and user object text while adding a plugin and resolving an owned collision", async () => {
  const userEntry = `{"package":"oh-my-opencode-slim@user","options":{
      // Keep this user-owned option comment.
      "nested": { "keep": true }
    }}`;
  const host = fixture(`{
  "keep": { "value": 42 },
  "plugins": [
    // The user selector takes precedence over Sherpa's selector.
    ${userEntry},
    "oh-my-opencode-slim@1"
  ]
}
`);
  try {
    const stateFile = path.join(host.directory, ".sherpa-owned.json");
    writeFileSync(stateFile, stateText({ version: 2, plugins: ["oh-my-opencode-slim@1"] }));

    expect(await syncHostConfig(host.directory, false)).toBe(true);

    const raw = readFileSync(host.configFile, "utf8");
    const config = host.read();
    expect(raw).toContain("// The user selector takes precedence over Sherpa's selector.");
    expect(raw).toContain("// Keep this user-owned option comment.");
    expect(raw).toContain(userEntry);
    expect(config.keep).toEqual({ value: 42 });
    expect(config.plugins).toEqual([{ package: "oh-my-opencode-slim@user", options: { nested: { keep: true } } }, DCP]);
    expect(JSON.parse(readFileSync(stateFile, "utf8")).plugins).toEqual([DCP]);
  } finally {
    host.dispose();
  }
});

test("removes only unchanged owned selectors no longer selected for this platform", async () => {
  const host = fixture("{}\n");
  try {
    await syncHostConfig(host.directory, true);
    expect(host.read().plugins).toHaveLength(3);
    const config = host.read();
    config.plugins.push(`${PLAYWRIGHT}-user-edited`);
    writeFileSync(host.configFile, JSON.stringify(config, null, 2));
    expect(await syncHostConfig(host.directory, false)).toBe(true);
    expect(host.read().plugins).toEqual([SLIM, DCP, `${PLAYWRIGHT}-user-edited`]);
  } finally {
    host.dispose();
  }
});

test("migrates v1 ownership by removing only unchanged Sherpa agents and commands", async () => {
  const legacy = legacyState();
  const host = fixture(JSON.stringify({
    plugins: [SLIM, DCP],
    agents: {
      "sherpa-owned": { description: "unchanged agent" },
      "sherpa-edited": { description: "user's agent edit" },
      "preexisting-user-agent": { description: "not tracked" },
    },
    commands: {
      "sherpa-owned": { template: "unchanged command" },
      "sherpa-edited": { template: "user's command edit" },
      "preexisting-user-command": { template: "not tracked" },
    },
  }, null, 2) + "\n");
  try {
    const stateFile = path.join(host.directory, ".sherpa-owned.json");
    writeFileSync(stateFile, stateText(legacy));
    expect(await syncHostConfig(host.directory, false)).toBe(true);
    const migrated = host.read();
    expect(migrated.agents).toEqual({
      "sherpa-edited": { description: "user's agent edit" },
      "preexisting-user-agent": { description: "not tracked" },
    });
    expect(migrated.commands).toEqual({
      "sherpa-edited": { template: "user's command edit" },
      "preexisting-user-command": { template: "not tracked" },
    });
    expect(JSON.parse(readFileSync(stateFile, "utf8"))).toEqual({ version: 2, plugins: [SLIM, DCP] });
  } finally {
    host.dispose();
  }
});

test("serializes concurrent syncs and leaves one consistent ownership journal", async () => {
  const host = fixture("{}\n");
  try {
    const results = await Promise.all([
      syncHostConfig(host.directory, false), syncHostConfig(host.directory, false),
    ]);
    expect(results.sort()).toEqual([false, true]);
    expect(host.read().plugins).toHaveLength(2);
    const owned = JSON.parse(readFileSync(path.join(host.directory, ".sherpa-owned.json"), "utf8"));
    expect(owned.version).toBe(2);
    expect(owned.plugins).toEqual(host.read().plugins);
  } finally {
    host.dispose();
  }
});

test("recovers an old v1 pending journal, then migrates its ownership state", async () => {
  const legacy = legacyState();
  const beforeConfig = JSON.stringify({
    plugins: [SLIM, DCP],
    agents: { "sherpa-owned": { description: "unchanged agent" } },
    commands: { "sherpa-owned": { template: "unchanged command" } },
  }, null, 2) + "\n";
  const host = fixture(beforeConfig);
  try {
    const stateFile = path.join(host.directory, ".sherpa-owned.json");
    const oldState = stateText(legacy);
    writeFileSync(stateFile, oldState);
    writeFileSync(path.join(host.directory, ".sherpa-sync-pending.json"), JSON.stringify({
      version: 1,
      beforeConfig: digest(beforeConfig),
      afterConfig: digest(beforeConfig),
      beforeState: digest(oldState),
      afterState: digest(oldState),
      nextState: legacy,
    }));
    expect(await syncHostConfig(host.directory, false)).toBe(true);
    expect(host.read().agents).toEqual({});
    expect(host.read().commands).toEqual({});
    expect(JSON.parse(readFileSync(stateFile, "utf8"))).toEqual({ version: 2, plugins: [SLIM, DCP] });
  } finally {
    host.dispose();
  }
});

test("recovers an interrupted v1-to-v2 state replacement after config replacement", async () => {
  const legacy = legacyState();
  const oldState = stateText(legacy);
  const nextState = { version: 2, plugins: [SLIM, DCP] };
  const afterConfig = JSON.stringify({ plugins: [SLIM, DCP], agents: {}, commands: {} }, null, 2) + "\n";
  const beforeConfig = JSON.stringify({
    plugins: [SLIM, DCP],
    agents: { "sherpa-owned": { description: "unchanged agent" } },
    commands: { "sherpa-owned": { template: "unchanged command" } },
  }, null, 2) + "\n";
  const host = fixture(afterConfig);
  try {
    const stateFile = path.join(host.directory, ".sherpa-owned.json");
    writeFileSync(stateFile, oldState);
    writeFileSync(path.join(host.directory, ".sherpa-sync-pending.json"), JSON.stringify({
      version: 1,
      beforeConfig: digest(beforeConfig),
      afterConfig: digest(afterConfig),
      beforeState: digest(oldState),
      afterState: digest(stateText(nextState)),
      nextState,
    }));
    expect(await syncHostConfig(host.directory, false)).toBe(false);
    expect(JSON.parse(readFileSync(stateFile, "utf8"))).toEqual(nextState);
  } finally {
    host.dispose();
  }
});

test("finishes an interrupted v2 config replacement before its ownership journal", async () => {
  const host = fixture("{}\n");
  try {
    await syncHostConfig(host.directory, false);
    const stateFile = path.join(host.directory, ".sherpa-owned.json");
    const oldState = readFileSync(stateFile, "utf8");
    const oldConfig = readFileSync(host.configFile, "utf8");
    const updated = host.read();
    updated.plugins[0] = "oh-my-opencode-slim@1";
    const nextConfig = `${JSON.stringify(updated, null, 2)}\n`;
    const nextState = JSON.parse(oldState);
    nextState.plugins[0] = "oh-my-opencode-slim@1";
    const nextStateRaw = stateText(nextState);
    writeFileSync(path.join(host.directory, ".sherpa-sync-pending.json"), JSON.stringify({
      version: 1, beforeConfig: digest(oldConfig), afterConfig: digest(nextConfig),
      beforeState: digest(oldState), afterState: digest(nextStateRaw), nextState,
    }));
    writeFileSync(host.configFile, nextConfig);
    expect(await syncHostConfig(host.directory, false)).toBe(true);
    expect(host.read().plugins[0]).toBe(SLIM);
    expect(JSON.parse(readFileSync(stateFile, "utf8")).plugins[0]).toBe(SLIM);
  } finally {
    host.dispose();
  }
});

test("stops rather than overwriting external edits during pending recovery", async () => {
  const host = fixture("{}\n");
  try {
    await syncHostConfig(host.directory, false);
    const stateFile = path.join(host.directory, ".sherpa-owned.json");
    const oldState = readFileSync(stateFile, "utf8");
    const oldConfig = readFileSync(host.configFile, "utf8");
    writeFileSync(path.join(host.directory, ".sherpa-sync-pending.json"), JSON.stringify({
      version: 1, beforeConfig: digest(oldConfig), afterConfig: digest("other config"),
      beforeState: digest(oldState), afterState: digest(oldState), nextState: JSON.parse(oldState),
    }));
    writeFileSync(host.configFile, '{"userEdited":true}\n');
    await expect(syncHostConfig(host.directory, false)).rejects.toThrow("manual recovery");
    expect(host.read().userEdited).toBe(true);
  } finally {
    host.dispose();
  }
});

test("rejects ambiguous, invalid, or symlinked global config without rewriting", async () => {
  const host = fixture("{ invalid json");
  try {
    await expect(syncHostConfig(host.directory, false)).rejects.toThrow("not a valid JSONC object");
    expect(readFileSync(host.configFile, "utf8")).toBe("{ invalid json");
    writeFileSync(host.configFile, "{}\n");
    writeFileSync(path.join(host.directory, "opencode.json"), "{}\n");
    await expect(syncHostConfig(host.directory, false)).rejects.toThrow("exactly one");
    rmSync(path.join(host.directory, "opencode.json"));
    rmSync(host.configFile);
    symlinkSync(path.join(host.directory, "target.jsonc"), host.configFile);
    writeFileSync(path.join(host.directory, "target.jsonc"), "{}\n");
    await expect(syncHostConfig(host.directory, false)).rejects.toThrow("must not be a symlink");
  } finally {
    host.dispose();
  }
});
