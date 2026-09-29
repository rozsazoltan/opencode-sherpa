import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Cleanup, Context } from "@opencode/plugin/promise/plugin";
import type { PermissionEvaluation } from "@opencode/plugin/promise/permission";
import type { SessionContext } from "@opencode/plugin/promise/session";
import type { MCPEditor } from "@opencode/plugin/promise/mcp";
import type { Registration } from "@opencode/plugin/promise/registration";
import SherpaPlugin from "../src/index.ts";

type PermissionDecision = Pick<PermissionEvaluation, "action" | "effect" | "resources">;

let fixtureQueue = Promise.resolve();

async function acquireFixture(): Promise<() => void> {
  const previous = fixtureQueue;
  let release = () => {};
  fixtureQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  return release;
}

test("registers default Sherpa services and disposes them", async () => {
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
    options: { language: "hu" },
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

  const cleanup = await SherpaPlugin.setup(context);
  expect(servers.has("github")).toBe(true);
  expect(servers.has("jina")).toBe(true);
  expect(servers.has("context7")).toBe(true);
  expect(servers.has("gh_grep")).toBe(true);

  const sessionContext = { system: [] } as unknown as SessionContext;
  await contextCallback?.(sessionContext);
  expect(sessionContext.system).toHaveLength(1);
  const systemMessage = sessionContext.system[0];
  if (systemMessage?.type === "text") expect(systemMessage.text).toMatch(/Use hu for conversation/);

  const permission: PermissionDecision = {
    action: "read",
    effect: "ask",
    resources: [path.join(os.tmpdir(), "opencode", "uploads", "file.txt")],
  };
  await permissionCallback?.(permission);
  expect(permission.effect).toBe("allow");

  await cleanup?.();
  expect(disposed).toEqual(["mcp.transform", "permission.evaluate", "session.context"]);
});

test("cleans up earlier registrations if MCP setup rejects", async () => {
  const disposed: string[] = [];
  const failure = new Error("MCP transform failed.");
  const context = {
    options: {},
    session: { hook: async () => ({ dispose: async () => { disposed.push("session.context"); } }) },
    permission: { hook: async () => ({ dispose: async () => { disposed.push("permission.evaluate"); } }) },
    mcp: { transform: async () => { throw failure; } },
  } as unknown as Context;

  await expect(SherpaPlugin.setup(context)).rejects.toBe(failure);
  expect(disposed).toEqual(["permission.evaluate", "session.context"]);
});

test("syncs only Sherpa external plugin selectors when explicitly enabled", async () => {
  const release = await acquireFixture();
  const root = await mkdtemp(path.join(os.tmpdir(), "sherpa-plugin-host-"));
  const previous = process.env.XDG_CONFIG_HOME;
  const configDirectory = path.join(root, "opencode");
  const configPath = path.join(configDirectory, "opencode.jsonc");
  try {
    await mkdir(configDirectory);
    await writeFile(configPath, '{"agents": {}, "commands": {}}\n');
    process.env.XDG_CONFIG_HOME = root;
    const context = {
      options: { hostSync: true },
      session: { hook: async () => ({ dispose: async () => {} }) },
      permission: { hook: async () => ({ dispose: async () => {} }) },
      mcp: { transform: async () => ({ dispose: async () => {} }) },
    } as unknown as Context;

    const cleanup = await SherpaPlugin.setup(context);
    const updated = JSON.parse(await readFile(configPath, "utf8"));
    expect(updated.plugins).toContain("oh-my-opencode-slim@2");
    expect(updated.plugins).toContain("@tarquinen/opencode-dcp@3");
    expect(updated.plugins).toContain(
      "opencode-caveman@git+https://github.com/rozsazoltan/opencode-caveman.git#9410a7fd011fb2b9e2e5cd9166dbf64a12031641",
    );
    await cleanup?.();
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    await rm(root, { recursive: true, force: true });
    release();
  }
});

test("keeps Sherpa running when opt-in host sync fails", async () => {
  const release = await acquireFixture();
  const root = await mkdtemp(path.join(os.tmpdir(), "sherpa-plugin-host-failure-"));
  const previous = process.env.XDG_CONFIG_HOME;
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  let cleanup: Cleanup | undefined;
  try {
    process.env.XDG_CONFIG_HOME = root;
    const context = {
      options: { hostSync: true },
      session: { hook: async () => ({ dispose: async () => {} }) },
      permission: { hook: async () => ({ dispose: async () => {} }) },
      mcp: { transform: async () => ({ dispose: async () => {} }) },
    } as unknown as Context;

    const registered = await SherpaPlugin.setup(context);
    if (typeof registered === "function") cleanup = registered;
    expect(warning).toHaveBeenCalledWith(
      "OpenCode Sherpa: optional host config sync failed; runtime registrations remain active.",
    );
    expect(warning.mock.calls[0]?.[0]).not.toContain(root);
  } finally {
    await cleanup?.();
    warning.mockRestore();
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    await rm(root, { recursive: true, force: true });
    release();
  }
});
