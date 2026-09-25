import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Cleanup, Context } from "@opencode/plugin/promise/plugin";
import type { PermissionEvaluation } from "@opencode/plugin/promise/permission";
import type { SessionContext } from "@opencode/plugin/promise/session";
import type { AgentEditor } from "@opencode/plugin/promise/agent";
import type { CommandDefinition, CommandEditor } from "@opencode/plugin/promise/command";
import type { MCPEditor } from "@opencode/plugin/promise/mcp";
import type { SkillEditor } from "@opencode/plugin/promise/skill";
import type { Registration } from "@opencode/plugin/promise/registration";
import SherpaPlugin from "../src/index.ts";
import { CAVEMAN_SKILL_NAMES } from "../src/skills.ts";

type PermissionDecision = Pick<PermissionEvaluation, "action" | "effect" | "resources">;
type SkillInfo = Parameters<SkillEditor["add"]>[0];
type MutableAgent = Parameters<Parameters<AgentEditor["update"]>[1]>[0];

let hostSyncFixtureQueue = Promise.resolve();

async function acquireHostSyncFixture(): Promise<() => void> {
  const previous = hostSyncFixtureQueue;
  let release = () => {};
  hostSyncFixtureQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  return release;
}

function runtimeDomains(disposed: string[] = [], commandFailure?: Error) {
  const agents = new Map<string, MutableAgent>();
  const commands = new Map<string, CommandDefinition>();
  const agentEditor = {
    list: () => [...agents.values()],
    get: (id: string) => agents.get(id),
    default: () => {},
    update: (id: string, update: Parameters<AgentEditor["update"]>[1]) => {
      const agent = {
        id,
        name: id,
        request: { settings: {}, headers: {}, body: {} },
        mode: "primary",
        hidden: false,
        permissions: [],
      } as unknown as MutableAgent;
      update(agent);
      agents.set(id, agent);
    },
    remove: (id: string) => { agents.delete(id); },
  } as unknown as AgentEditor;
  const commandEditor = {
    add: (definition: CommandDefinition) => { commands.set(definition.name, definition); },
  } as CommandEditor;

  return {
    agents,
    commands,
    api: {
      agent: {
        transform: async (callback: (editor: AgentEditor) => void) => {
          callback(agentEditor);
          return { dispose: async () => { disposed.push("agent.transform"); } };
        },
      },
      command: {
        list: async () => ({ data: [] }),
        transform: async (callback: (editor: CommandEditor) => void) => {
          if (commandFailure) throw commandFailure;
          callback(commandEditor);
          return { dispose: async () => { disposed.push("command.transform"); } };
        },
      },
    },
  };
}

test("registers plugin services and runtime Cavecrew features and disposes them", async () => {
  const disposed: string[] = [];
  const defaultDirectory = path.join(os.tmpdir(), "opencode");
  const extraDirectory = path.join(os.tmpdir(), "sherpa-plugin-extra");
  const excludedDirectory = path.join(defaultDirectory, "private");
  const servers = new Map<string, unknown>();
  const skills = new Map<string, SkillInfo>();
  const runtime = runtimeDomains(disposed);
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
    ...runtime.api,
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
  expect([...skills.keys()].sort()).toEqual([...CAVEMAN_SKILL_NAMES].sort());
  expect([...runtime.agents.keys()].sort()).toEqual([
    "cavecrew-builder", "cavecrew-investigator", "cavecrew-reviewer",
  ]);
  expect([...runtime.commands.keys()].sort()).toEqual([
    "caveman", "caveman-commit", "caveman-compress", "caveman-help", "caveman-review", "caveman-stats",
  ]);

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
    "command.transform",
    "agent.transform",
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
  const runtime = runtimeDomains(disposed);
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
    ...runtime.api,
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
    expect([...skills.keys()].sort()).toEqual([...CAVEMAN_SKILL_NAMES].sort());
    expect(runtime.agents.size).toBe(3);
    expect(runtime.commands.size).toBe(6);
  } finally {
    await cleanup?.();
    await rm(directory, { recursive: true, force: true });
  }

  expect(disposed).toEqual([
    "command.transform",
    "agent.transform",
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
  const runtime = runtimeDomains();
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
    ...runtime.api,
  } as unknown as Context;

  await SherpaPlugin.setup(context);

  expect(skills.get("caveman")).toBe(collision);
  expect(added.sort()).toEqual([...CAVEMAN_SKILL_NAMES].filter((name) => name !== "caveman").sort());
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

test("rolls back agent and earlier registrations when command setup rejects", async () => {
  const disposed: string[] = [];
  const failure = new Error("Command transform failed.");
  const runtime = runtimeDomains(disposed, failure);
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
      transform: async () => ({ dispose: async () => { disposed.push("skill.transform"); } }),
    },
    ...runtime.api,
  } as unknown as Context;

  let caught: unknown;
  try {
    await SherpaPlugin.setup(context);
  } catch (error) {
    caught = error;
  }

  expect(caught).toBe(failure);
  expect(disposed).toEqual([
    "agent.transform",
    "skill.transform",
    "mcp.transform",
    "permission.evaluate",
    "session.context",
  ]);
});

test("syncs host config only when explicitly enabled", async () => {
  const releaseFixture = await acquireHostSyncFixture();
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
      skill: { transform: async () => ({ dispose: async () => {} }) },
      ...runtimeDomains().api,
    } as unknown as Context;
    const cleanup = await SherpaPlugin.setup(context);
    const updated = JSON.parse(await readFile(configPath, "utf8"));
    expect(updated.plugins).toContain("oh-my-opencode-slim@2");
    await cleanup?.();
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    await rm(root, { recursive: true, force: true });
    releaseFixture();
  }
});

test("keeps runtime registrations active when opt-in host sync fails", async () => {
  const releaseFixture = await acquireHostSyncFixture();
  const root = await mkdtemp(path.join(os.tmpdir(), "sherpa-plugin-host-failure-"));
  const previous = process.env.XDG_CONFIG_HOME;
  const configDirectory = path.join(root, "opencode");
  const runtime = runtimeDomains();
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  let cleanup: Cleanup | undefined;
  try {
    await mkdir(configDirectory);
    process.env.XDG_CONFIG_HOME = root;
    const context = {
      options: { hostSync: true },
      session: { hook: async () => ({ dispose: async () => {} }) },
      permission: { hook: async () => ({ dispose: async () => {} }) },
      mcp: { transform: async () => ({ dispose: async () => {} }) },
      skill: { transform: async () => ({ dispose: async () => {} }) },
      ...runtime.api,
    } as unknown as Context;

    const registeredCleanup = await SherpaPlugin.setup(context);
    if (typeof registeredCleanup === "function") cleanup = registeredCleanup;

    expect(runtime.agents.size).toBe(3);
    expect(runtime.commands.size).toBe(6);
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
    releaseFixture();
  }
});
