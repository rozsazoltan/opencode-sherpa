import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "jsonc-parser";
import { syncHostConfig } from "../src/host-config.ts";

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

test("adds external plugins, cavecrew agents, and Caveman commands to a clean host config", async () => {
  const host = fixture('{\n  "$schema": "https://opencode.ai/config.json"\n}\n');
  try {
    expect(await syncHostConfig(host.directory, false)).toBe(true);
    const config = host.read();
    expect(config.plugins).toEqual(["oh-my-opencode-slim@2", "@tarquinen/opencode-dcp@3"]);
    expect(Object.keys(config.agents).sort()).toEqual([
      "cavecrew-builder", "cavecrew-investigator", "cavecrew-reviewer",
    ]);
    expect(config.agents["cavecrew-investigator"].mode).toBe("subagent");
    expect(config.agents["cavecrew-investigator"].permissions).toContainEqual({
      action: "edit", resource: "*", effect: "deny",
    });
    expect(config.agents["cavecrew-reviewer"].system).toContain("Review only the diff or file excerpts supplied");
    expect(config.agents["cavecrew-reviewer"].system).not.toContain("`Bash` only for `git diff`");
    expect(config.agents["cavecrew-investigator"].system).toContain("Shell is unavailable");
    expect(config.agents["cavecrew-builder"].permissions).toContainEqual({
      action: "shell", resource: "*", effect: "deny",
    });
    expect(Object.keys(config.commands).sort()).toEqual([
      "caveman", "caveman-commit", "caveman-compress", "caveman-help", "caveman-review", "caveman-stats",
    ]);
    expect(config.commands["caveman-compress"].template).toContain("$ARGUMENTS");
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
    expect(config.plugins).toContain("@tarquinen/opencode-dcp@3");
    expect(config.plugins.some((item: string) => typeof item === "string" && item.startsWith("opencode-playwright@git+"))).toBe(true);
    expect(config.agents["cavecrew-builder"]).toEqual({ description: "my agent" });
    expect(config.commands.caveman).toEqual({ template: "my command" });
    expect(await syncHostConfig(host.directory, true)).toBe(false);
  } finally {
    host.dispose();
  }
});

test("updates an owned entry but never overwrites a user-edited one", async () => {
  const host = fixture("{}\n", "opencode.json");
  try {
    await syncHostConfig(host.directory, false);
    const ownedFile = path.join(host.directory, ".sherpa-owned.json");
    const state = JSON.parse(readFileSync(ownedFile, "utf8"));
    state.commands["caveman-help"].template = "previous Sherpa template";
    const old = host.read();
    old.commands["caveman-help"].template = "previous Sherpa template";
    old.commands["caveman-review"].template = "user edited template";
    writeFileSync(host.configFile, JSON.stringify(old, null, 2));
    writeFileSync(ownedFile, JSON.stringify(state));
    expect(await syncHostConfig(host.directory, false)).toBe(true);
    const updated = host.read();
    expect(updated.commands["caveman-help"].template).toContain("caveman-help skill");
    expect(updated.commands["caveman-review"].template).toBe("user edited template");
  } finally {
    host.dispose();
  }
});

test("removes only previously owned entries no longer selected for this platform", async () => {
  const host = fixture("{}\n");
  try {
    await syncHostConfig(host.directory, true);
    expect(host.read().plugins).toHaveLength(3);
    expect(await syncHostConfig(host.directory, false)).toBe(true);
    expect(host.read().plugins).toEqual(["oh-my-opencode-slim@2", "@tarquinen/opencode-dcp@3"]);
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
    expect(owned.plugins).toEqual(host.read().plugins);
  } finally {
    host.dispose();
  }
});

test("finishes an interrupted config replacement before its ownership journal", async () => {
  const host = fixture("{}\n");
  try {
    await syncHostConfig(host.directory, false);
    const stateFile = path.join(host.directory, ".sherpa-owned.json");
    const oldState = readFileSync(stateFile, "utf8");
    const oldConfig = readFileSync(host.configFile, "utf8");
    const updated = host.read();
    updated.commands["caveman-help"].template = "next owned version";
    const nextConfig = `${JSON.stringify(updated, null, 2)}\n`;
    const nextState = JSON.parse(oldState);
    nextState.commands["caveman-help"].template = "next owned version";
    const nextStateText = `${JSON.stringify(nextState, null, 2)}\n`;
    const digest = (text: string) => createHash("sha256").update(text).digest("hex");
    writeFileSync(path.join(host.directory, ".sherpa-sync-pending.json"), JSON.stringify({
      version: 1, beforeConfig: digest(oldConfig), afterConfig: digest(nextConfig),
      beforeState: digest(oldState), afterState: digest(nextStateText), nextState,
    }));
    writeFileSync(host.configFile, nextConfig);
    expect(await syncHostConfig(host.directory, false)).toBe(true);
    expect(host.read().commands["caveman-help"].template).toContain("caveman-help skill");
    expect(readFileSync(stateFile, "utf8")).toContain("caveman-help skill");
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
    const digest = (text: string) => createHash("sha256").update(text).digest("hex");
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
