import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Cleanup, Context } from "@opencode/plugin/promise/plugin";
import type { PermissionEvaluation } from "@opencode/plugin/promise/permission";
import type { SessionContext } from "@opencode/plugin/promise/session";
import type { MCPEditor } from "@opencode/plugin/promise/mcp";
import type { SkillEditor } from "@opencode/plugin/promise/skill";
import type { Registration } from "@opencode/plugin/promise/registration";
import SherpaPlugin from "../src/index.ts";

type PermissionDecision = Pick<PermissionEvaluation, "action" | "effect" | "resources">;
type SkillInfo = Parameters<SkillEditor["add"]>[0];

test("registers context, permission, MCP, and skills and disposes them", async () => {
  const disposed: string[] = [];
  const defaultDirectory = path.join(os.tmpdir(), "opencode");
  const extraDirectory = path.join(os.tmpdir(), "sherpa-plugin-extra");
  const excludedDirectory = path.join(defaultDirectory, "private");
  const servers = new Map<string, unknown>();
  const skills = new Map<string, SkillInfo>();
  let contextCallback: ((input: SessionContext) => void | Promise<void>) | undefined;
  let permissionCallback: ((input: PermissionDecision) => void | Promise<void>) | undefined;
  const editor = {
    list: () => [...servers.entries()],
    get: (name: string) => servers.get(name),
    set: (name: string, config: unknown) => { servers.set(name, config); },
    update: () => {},
    remove: (name: string) => { servers.delete(name); },
  } as unknown as MCPEditor;

  const sessionHook = async (
    name: "context",
    callback: (input: SessionContext) => void | Promise<void>,
  ): Promise<Registration> => {
    expect(name).toBe("context");
    contextCallback = callback;
    return { dispose: async () => { disposed.push(`session.${name}`); } };
  };

  const permissionHook = async (
    name: "evaluate",
    callback: (input: PermissionDecision) => void | Promise<void>,
  ): Promise<Registration> => {
    expect(name).toBe("evaluate");
    permissionCallback = callback;
    return { dispose: async () => { disposed.push(`permission.${name}`); } };
  };

  const mcpTransform = async (callback: (editor: MCPEditor) => void): Promise<Registration> => {
    callback(editor);
    return { dispose: async () => { disposed.push("mcp.transform"); } };
  };

  const skillEditor = {
    get: (id: string) => skills.get(id),
    add: (skill: SkillInfo) => { skills.set(String(skill.id), skill); },
  } as unknown as SkillEditor;
  const skillTransform = async (callback: (editor: SkillEditor) => void): Promise<Registration> => {
    callback(skillEditor);
    return { dispose: async () => { disposed.push("skill.transform"); } };
  };

  const context = {
    options: {
      language: "hu",
      mcp: { githubAuth: "oauth" },
      permissions: {
        allowDirectories: [extraDirectory],
        denyDirectories: [excludedDirectory],
      },
    },
    session: { hook: sessionHook },
    permission: { hook: permissionHook },
    mcp: { transform: mcpTransform },
    skill: { transform: skillTransform },
  } as unknown as Context;
  const cleanup = await SherpaPlugin.setup(context);

  expect(contextCallback).toBeDefined();
  expect(permissionCallback).toBeDefined();
  expect(servers.get("github")).toEqual({
    type: "remote",
    url: "https://api.githubcopilot.com/mcp/",
  });
  expect(servers.get("jina")).toEqual({
    type: "remote",
    url: "https://mcp.jina.ai/v1",
  });
  expect([...skills.keys()].sort()).toEqual(["caveman", "caveman-commit", "caveman-review"]);

  const sessionContext = { system: [] } as unknown as SessionContext;
  await contextCallback?.(sessionContext);
  expect(sessionContext.system).toHaveLength(1);
  const systemMessage = sessionContext.system[0];
  expect(systemMessage?.type).toBe("text");
  if (systemMessage?.type === "text") {
    expect(systemMessage.text).toMatch(/Use hu for conversation/);
  }

  for (const action of ["external_directory", "read", "edit"]) {
    const permission: PermissionDecision = {
      action,
      effect: "ask",
      resources: [path.join(defaultDirectory, "uploads", "file.txt")],
    };
    await permissionCallback?.(permission);
    expect(permission.effect).toBe("allow");
  }

  const extraDirectoryPermission: PermissionDecision = {
    action: "edit",
    effect: "ask",
    resources: [path.join(extraDirectory, "file.txt")],
  };
  await permissionCallback?.(extraDirectoryPermission);
  expect(extraDirectoryPermission.effect).toBe("allow");

  const excludedPermission: PermissionDecision = {
    action: "read",
    effect: "allow",
    resources: [path.join(excludedDirectory, "secret.txt")],
  };
  await permissionCallback?.(excludedPermission);
  expect(excludedPermission.effect).toBe("deny");

  const broadDirectoryGate: PermissionDecision = {
    action: "external_directory",
    effect: "ask",
    resources: [defaultDirectory],
  };
  await permissionCallback?.(broadDirectoryGate);
  expect(broadDirectoryGate.effect).toBe("deny");

  const deniedShellPermission: PermissionDecision = {
    action: "shell",
    effect: "ask",
    resources: [path.join(excludedDirectory, "script.sh")],
  };
  await permissionCallback?.(deniedShellPermission);
  expect(deniedShellPermission.effect).toBe("ask");

  const mixedPermission: PermissionDecision = {
    action: "read",
    effect: "ask",
    resources: [
      path.join(defaultDirectory, "public.txt"),
      path.join(os.tmpdir(), "outside", "file.txt"),
    ],
  };
  await permissionCallback?.(mixedPermission);
  expect(mixedPermission.effect).toBe("ask");

  await cleanup?.();
  expect(disposed).toEqual([
    "skill.transform",
    "mcp.transform",
    "permission.evaluate",
    "session.context",
  ]);
});

test("completes plugin setup when token-file GitHub registration collides with a host server", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sherpa-plugin-"));
  const missingTokenFile = path.join(directory, "missing-github-key");
  const disposed: string[] = [];
  const existingGithub = { type: "remote", url: "https://github.example/mcp" };
  const servers = new Map<string, unknown>([["github", existingGithub]]);
  const skills = new Map<string, SkillInfo>();
  let contextCallback: ((input: SessionContext) => void | Promise<void>) | undefined;
  let permissionCallback: ((input: PermissionDecision) => void | Promise<void>) | undefined;
  let cleanup: Cleanup | undefined;

  const editor = {
    list: () => [...servers.entries()],
    get: (name: string) => servers.get(name),
    set: (name: string, config: unknown) => { servers.set(name, config); },
    update: () => {},
    remove: (name: string) => { servers.delete(name); },
  } as unknown as MCPEditor;
  const skillEditor = {
    get: (id: string) => skills.get(id),
    add: (skill: SkillInfo) => { skills.set(String(skill.id), skill); },
  } as unknown as SkillEditor;

  const context = {
    options: { mcp: { githubAuth: "token-file", githubTokenFile: missingTokenFile } },
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
      transform: async (callback: (editor: MCPEditor) => void) => {
        callback(editor);
        return { dispose: async () => { disposed.push("mcp.transform"); } };
      },
    },
    skill: {
      transform: async (callback: (editor: SkillEditor) => void) => {
        callback(skillEditor);
        return { dispose: async () => { disposed.push("skill.transform"); } };
      },
    },
  } as unknown as Context;

  try {
    const registeredCleanup = await SherpaPlugin.setup(context);
    if (typeof registeredCleanup === "function") cleanup = registeredCleanup;

    expect(contextCallback).toBeDefined();
    expect(permissionCallback).toBeDefined();
    expect(servers.get("github")).toBe(existingGithub);
    expect(servers.get("jina")).toEqual({
      type: "remote",
      url: "https://mcp.jina.ai/v1",
    });
    expect([...skills.keys()].sort()).toEqual(["caveman", "caveman-commit", "caveman-review"]);
  } finally {
    await cleanup?.();
    await rm(directory, { recursive: true, force: true });
  }

  expect(disposed).toEqual([
    "skill.transform",
    "mcp.transform",
    "permission.evaluate",
    "session.context",
  ]);
});

test("does not replace an existing skill during plugin setup", async () => {
  const collision = {
    id: "caveman",
    name: "existing caveman",
    description: "Owned by another source.",
    path: "/existing/SKILL.md",
    content: "Do not replace this skill.",
  } as SkillInfo;
  const skills = new Map<string, SkillInfo>([["caveman", collision]]);
  const added: string[] = [];
  const skillEditor = {
    get: (id: string) => skills.get(id),
    add: (skill: SkillInfo) => {
      added.push(String(skill.id));
      skills.set(String(skill.id), skill);
    },
  } as unknown as SkillEditor;

  const context = {
    options: {},
    session: { hook: async () => ({ dispose: async () => {} }) },
    permission: { hook: async () => ({ dispose: async () => {} }) },
    mcp: { transform: async () => ({ dispose: async () => {} }) },
    skill: { transform: async (callback: (editor: SkillEditor) => void) => {
      callback(skillEditor);
      return { dispose: async () => {} };
    } },
  } as unknown as Context;

  await SherpaPlugin.setup(context);

  expect(skills.get("caveman")).toBe(collision);
  expect(added.sort()).toEqual(["caveman-commit", "caveman-review"]);
});

test("cleans up earlier registrations if MCP setup rejects", async () => {
  const disposed: string[] = [];
  const failure = new Error("MCP transform failed.");

  const context = {
    options: {},
    session: {
      hook: async () => ({ dispose: async () => { disposed.push("session.context"); } }),
    },
    permission: {
      hook: async () => ({ dispose: async () => { disposed.push("permission.evaluate"); } }),
    },
    mcp: {
      transform: async () => { throw failure; },
    },
  } as unknown as Context;

  let caught: unknown;
  try {
    await SherpaPlugin.setup(context);
  } catch (error) {
    caught = error;
  }

  expect(caught).toBe(failure);
  expect(disposed).toEqual(["permission.evaluate", "session.context"]);
});

test("cleans up MCP, permission, and session registrations if skill setup rejects", async () => {
  const disposed: string[] = [];
  const failure = new Error("Skill transform failed.");

  const context = {
    options: {},
    session: {
      hook: async () => ({ dispose: async () => { disposed.push("session.context"); } }),
    },
    permission: {
      hook: async () => ({ dispose: async () => { disposed.push("permission.evaluate"); } }),
    },
    mcp: {
      transform: async () => ({ dispose: async () => { disposed.push("mcp.transform"); } }),
    },
    skill: {
      transform: async () => { throw failure; },
    },
  } as unknown as Context;

  let caught: unknown;
  try {
    await SherpaPlugin.setup(context);
  } catch (error) {
    caught = error;
  }

  expect(caught).toBe(failure);
  expect(disposed).toEqual(["mcp.transform", "permission.evaluate", "session.context"]);
});
