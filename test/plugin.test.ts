import { expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { PermissionEvaluation } from "@opencode/plugin/promise/permission";
import type { SessionContext } from "@opencode/plugin/promise/session";
import type { MCPEditor } from "@opencode/plugin/promise/mcp";
import type { Registration } from "@opencode/plugin/promise/registration";
import SherpaPlugin from "../src/index.ts";

type PermissionDecision = Pick<PermissionEvaluation, "action" | "effect" | "resources">;

async function createProject(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "sherpa-plugin-test-"));
}

test("registers default Sherpa services and disposes them", async () => {
  const project = await createProject();
  const configPath = path.join(project, ".opencode", "oh-my-opencode-slim.jsonc");
  const promptPath = path.join(project, ".opencode", "oh-my-opencode-slim", "sherpa-stale.md");
  mkdirSync(path.dirname(promptPath), { recursive: true });
  writeFileSync(configPath, '{"agents":{"sherpa-stale":true},"presets":{"session":{"sherpa-stale":{"inheritModelFrom":"session"}}}}\n');
  writeFileSync(promptPath, "Stale prompt.\n");
  const disposed: string[] = [];
  const servers = new Map<string, unknown>();
  let contextCallback: ((input: SessionContext) => void | Promise<void>) | undefined;
  let permissionCallback: ((input: PermissionDecision) => void | Promise<void>) | undefined;
  const editor = {
    list: () => [...servers.entries()],
    get: (name: string) => servers.get(name),
    set: (name: string, config: unknown) => { servers.set(name, config); },
    update: () => {},
    remove: (name: string) => { servers.delete(name); },
  } as unknown as MCPEditor;

  const context = {
    options: { language: "hu", agentSources: [] },
    location: { project: { directory: project } },
    session: {
      hook: async (_name: "context", callback: (input: SessionContext) => void | Promise<void>) => {
        contextCallback = callback;
        return { dispose: async () => { disposed.push("session.context"); } };
      },
    },
    permission: {
      hook: async (_name: "evaluate", callback: (input: PermissionDecision) => void | Promise<void>) => {
        permissionCallback = callback;
        return { dispose: async () => { disposed.push("permission.evaluate"); } };
      },
    },
    mcp: {
      transform: async (callback: (editor: MCPEditor) => void): Promise<Registration> => {
        callback(editor);
        return { dispose: async () => { disposed.push("mcp.transform"); } };
      },
    },
  } as unknown as Context;

  let cleanup: (() => Promise<void> | void) | undefined;
  try {
    const registered = await SherpaPlugin.setup(context);
    if (typeof registered === "function") cleanup = registered;
    expect(readFileSync(configPath, "utf8")).not.toContain("sherpa-stale");
    expect(() => readFileSync(promptPath, "utf8")).toThrow();
    expect(servers.has("github")).toBe(true);
    expect(servers.has("jina")).toBe(true);
    expect(servers.has("context7")).toBe(true);
    expect(servers.has("gh_grep")).toBe(true);

    const sessionContext = { system: [] } as unknown as SessionContext;
    await contextCallback?.(sessionContext);
    expect(sessionContext.system).toHaveLength(1);
    const systemMessage = sessionContext.system[0];
    expect(systemMessage?.type).toBe("text");
    const systemText = (systemMessage as { readonly type: "text"; readonly text: string }).text;
    expect(systemText).toMatch(/Use hu for conversation/);
    expect(systemText).toMatch(/Prefer simple, minimal, reusable solutions/);

    const permission: PermissionDecision = {
      action: "read",
      effect: "ask",
      resources: [path.join(os.tmpdir(), "opencode", "uploads", "file.txt")],
    };
    await permissionCallback?.(permission);
    expect(permission.effect).toBe("allow");

  } finally {
    await cleanup?.();
    await rm(project, { recursive: true, force: true });
  }
});

test("cleans up earlier registrations if MCP setup rejects", async () => {
  const project = await createProject();
  const disposed: string[] = [];
  const failure = new Error("MCP transform failed.");
  const context = {
    options: { agentSources: [] },
    location: { project: { directory: project } },
    session: { hook: async () => ({ dispose: async () => { disposed.push("session.context"); throw new Error("Session cleanup failed."); } }) },
    permission: { hook: async () => ({ dispose: async () => { disposed.push("permission.evaluate"); throw undefined; } }) },
    mcp: { transform: async () => { throw failure; } },
  } as unknown as Context;

  try {
    await expect(SherpaPlugin.setup(context)).rejects.toBe(failure);
    expect(disposed).toEqual(["permission.evaluate", "session.context"]);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("continues cleanup after disposal errors and rethrows first error", async () => {
  for (const failure of [new Error("MCP cleanup failed."), undefined]) {
    const project = await createProject();
    const disposed: string[] = [];
    const registration = (name: string, error?: unknown): Registration => ({
      dispose: async () => {
        disposed.push(name);
        if (name === "mcp.transform") throw error;
      },
    });
    const context = {
      options: { agentSources: [] },
      location: { project: { directory: project } },
      session: { hook: async () => registration("session.context") },
      permission: { hook: async () => registration("permission.evaluate") },
      mcp: { transform: async () => registration("mcp.transform", failure) },
    } as unknown as Context;

    try {
      const cleanup = await SherpaPlugin.setup(context);
      let rejected = false;
      let actual: unknown;
      try {
        await cleanup?.();
      } catch (error) {
        rejected = true;
        actual = error;
      }

      expect(rejected).toBe(true);
      expect(actual).toBe(failure);
      expect(disposed).toEqual(["mcp.transform", "permission.evaluate", "session.context"]);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  }
});
