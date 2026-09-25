import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { Cleanup, Context } from "@opencode/plugin/promise/plugin";
import type { PermissionEvaluation } from "@opencode/plugin/promise/permission";
import type { SessionContext, SessionHooks } from "@opencode/plugin/promise/session";
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

test("registers default plugin services without opting into Caveman and disposes them", async () => {
  const disposed: string[] = [];
  const defaultDirectory = path.join(os.tmpdir(), "opencode");
  const extraDirectory = path.join(os.tmpdir(), "sherpa-plugin-extra");
  const excludedDirectory = path.join(defaultDirectory, "private");
  const servers = new Map<string, unknown>();
  const skills = new Map<string, SkillInfo>();
  const runtime = runtimeDomains(disposed);
  let skillTransformCalled = false;
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
    skillTransformCalled = true;
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
  expect(skillTransformCalled).toBe(false);
  expect(skills.size).toBe(0);
  expect(runtime.agents.size).toBe(0);
  expect(runtime.commands.size).toBe(0);

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
    "mcp.transform",
    "permission.evaluate",
    "session.context",
  ]);
});

test("completes default setup when token-file GitHub registration collides with a host server", async () => {
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
    expect(skills.size).toBe(0);
    expect(runtime.agents.size).toBe(0);
    expect(runtime.commands.size).toBe(0);
  } finally {
    await cleanup?.();
    await rm(directory, { recursive: true, force: true });
  }

  expect(disposed).toEqual([
    "mcp.transform",
    "permission.evaluate",
    "session.context",
  ]);
});

test("leaves existing skills untouched when Caveman installation is disabled", async () => {
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
  expect(added).toEqual([]);
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

test("does not run a failing Caveman skill transform when installation is disabled", async () => {
  const disposed: string[] = [];
  let cleanup: Cleanup | undefined;

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
      transform: async () => { throw new Error("Caveman registration must stay disabled."); },
    },
  } as unknown as Context;

  try {
    const registeredCleanup = await SherpaPlugin.setup(context);
    if (typeof registeredCleanup === "function") cleanup = registeredCleanup;

    expect(disposed).toEqual([]);
  } finally {
    await cleanup?.();
  }

  expect(disposed).toEqual(["mcp.transform", "permission.evaluate", "session.context"]);
});

test("does not run a failing Caveman command transform when installation is disabled", async () => {
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

  const cleanup = await SherpaPlugin.setup(context);
  expect(runtime.agents.size).toBe(0);
  expect(runtime.commands.size).toBe(0);
  await cleanup?.();

  expect(disposed).toEqual([
    "mcp.transform",
    "permission.evaluate",
    "session.context",
  ]);
});

test("rejects non-boolean Caveman installation options before registering services", async () => {
  const called: string[] = [];
  const context = {
    options: { cavemanInstall: "true" },
    session: { hook: async () => { called.push("session"); throw new Error("unexpected"); } },
    permission: { hook: async () => { called.push("permission"); throw new Error("unexpected"); } },
    mcp: { transform: async () => { called.push("mcp"); throw new Error("unexpected"); } },
  } as unknown as Context;

  await expect(SherpaPlugin.setup(context)).rejects.toThrow("cavemanInstall must be a boolean.");
  expect(called).toEqual([]);
});

test("rolls back default registrations when opted-in installation fails inside isolated XDG config", async () => {
  const releaseFixture = await acquireHostSyncFixture();
  const previousXdg = process.env.XDG_CONFIG_HOME;
  let root: string | undefined;
  try {
    root = await mkdtemp(path.join(os.tmpdir(), "sherpa-plugin-install-failure-"));
    const configDirectory = path.join(root, "opencode");
    await mkdir(configDirectory);
    const agentsPath = path.join(configDirectory, "AGENTS.md");
    const configPath = path.join(configDirectory, "opencode.jsonc");
    const agentsContents = "User-owned OpenCode instructions.\n";
    const configContents = '{"plugins": ["user-plugin"]}\n';
    const sherpaBlocker = "Keep this user-owned file.\n";
    await writeFile(agentsPath, agentsContents);
    await writeFile(configPath, configContents);
    await writeFile(path.join(configDirectory, ".sherpa"), sherpaBlocker);
    process.env.XDG_CONFIG_HOME = root;

    const disposed: string[] = [];
    const context = {
      options: { cavemanInstall: true },
      session: {
        hook: async () => ({ dispose: async () => { disposed.push("session.context"); } }),
      },
      permission: {
        hook: async () => ({ dispose: async () => { disposed.push("permission.evaluate"); } }),
      },
      mcp: {
        transform: async () => ({ dispose: async () => { disposed.push("mcp.transform"); } }),
      },
    } as unknown as Context;

    await expect(SherpaPlugin.setup(context)).rejects.toThrow("The .sherpa path must be a real directory.");
    expect(disposed).toEqual(["mcp.transform", "permission.evaluate", "session.context"]);
    expect(await readFile(agentsPath, "utf8")).toBe(agentsContents);
    expect(await readFile(configPath, "utf8")).toBe(configContents);
    expect(await readFile(path.join(configDirectory, ".sherpa"), "utf8")).toBe(sherpaBlocker);
    expect((await readdir(configDirectory)).sort()).toEqual([".sherpa", "AGENTS.md", "opencode.jsonc"].sort());
  } finally {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    if (root) await rm(root, { recursive: true, force: true });
    releaseFixture();
  }
});

function requireNode18(): void {
  let version: string;
  try {
    version = execFileSync("node", ["--version"], { encoding: "utf8" }).trim();
  } catch (error) {
    throw new Error("The Caveman plugin integration test requires executable Node.js >=18 on PATH.", { cause: error });
  }

  const major = /^v?(\d+)\./u.exec(version)?.[1];
  if (!major || Number(major) < 18) {
    throw new Error(`The Caveman plugin integration test requires Node.js >=18; found ${version || "unknown version"}.`);
  }
}

test("opts into Caveman, installs the pinned payload, and rolls back a registration failure", async () => {
  requireNode18();
  const releaseFixture = await acquireHostSyncFixture();
  const previousXdg = process.env.XDG_CONFIG_HOME;
  let root: string | undefined;
  let cleanup: Cleanup | undefined;
  try {
    root = await mkdtemp(path.join(os.tmpdir(), "sherpa-plugin-opt-in-"));
    const configDirectory = path.join(root, "opencode");
    await mkdir(configDirectory);
    const agentsPath = path.join(configDirectory, "AGENTS.md");
    const configPath = path.join(configDirectory, "opencode.jsonc");
    const agentsContents = "User-owned OpenCode instructions.\n";
    const configContents = '{\n  "plugins": ["user-plugin"],\n  "custom": true,\n}\n';
    await writeFile(agentsPath, agentsContents);
    await writeFile(configPath, configContents);
    process.env.XDG_CONFIG_HOME = root;

    const disposed: string[] = [];
    const hookNames: string[] = [];
    const contextCallbacks: Array<(input: SessionHooks["context"]) => void | Promise<void>> = [];
    let promptCallback: ((input: SessionHooks["prompt"]) => void | Promise<void>) | undefined;
    const servers = new Map<string, unknown>();
    const skills = new Map<string, SkillInfo>();
    const runtime = runtimeDomains(disposed);
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
      options: { cavemanInstall: true },
      session: {
        hook: async (
          name: "context" | "prompt",
          callback: ((input: SessionHooks["context"]) => void | Promise<void>) |
            ((input: SessionHooks["prompt"]) => void | Promise<void>),
        ): Promise<Registration> => {
          hookNames.push(name);
          if (name === "context") contextCallbacks.push(callback as (input: SessionHooks["context"]) => void | Promise<void>);
          else promptCallback = callback as (input: SessionHooks["prompt"]) => void | Promise<void>;
          return { dispose: async () => { disposed.push(`session.${name}`); } };
        },
      },
      permission: {
        hook: async () => ({ dispose: async () => { disposed.push("permission.evaluate"); } }),
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

    const registeredCleanup = await SherpaPlugin.setup(context);
    if (typeof registeredCleanup === "function") cleanup = registeredCleanup;

    const installedRoot = path.join(configDirectory, ".sherpa", "caveman", "opencode");
    expect(JSON.parse(await readFile(path.join(installedRoot, ".sherpa-install.json"), "utf8"))).toMatchObject({
      installer: "caveman-installer",
    });
    expect(await readFile(path.join(installedRoot, "AGENTS.md"), "utf8")).toContain("Respond terse like smart caveman");
    expect((await readdir(path.join(installedRoot, "skills"))).sort()).toEqual([...CAVEMAN_SKILL_NAMES].sort());
    expect([...skills.keys()].sort()).toEqual([...CAVEMAN_SKILL_NAMES].sort());
    expect([...runtime.agents.keys()].sort()).toEqual([
      "cavecrew-builder", "cavecrew-investigator", "cavecrew-reviewer",
    ]);
    expect([...runtime.commands.keys()].sort()).toEqual([
      "caveman", "caveman-commit", "caveman-compress", "caveman-help", "caveman-review", "caveman-stats",
    ]);
    expect(hookNames).toEqual(["context", "prompt", "context"]);
    expect(promptCallback).toBeDefined();

    const system: SessionHooks["context"]["system"] = [];
    await contextCallbacks[0]?.({ system } as SessionHooks["context"]);
    expect(system.some((part) => part.type === "text" && part.text.includes("Write new code identifiers"))).toBe(true);
    const activationPrompt: SessionHooks["prompt"] = {
      sessionID: "sherpa-plugin-integration" as SessionHooks["prompt"]["sessionID"],
      messageID: "sherpa-plugin-integration-message" as SessionHooks["prompt"]["messageID"],
      prompt: { text: "/caveman ultra" },
      delivery: "queue",
    };
    await promptCallback?.(activationPrompt);
    await contextCallbacks[1]?.({
      sessionID: "sherpa-plugin-integration" as SessionHooks["context"]["sessionID"],
      system,
      messages: [{
        id: activationPrompt.messageID,
        role: "user",
        content: [{ type: "text", text: activationPrompt.prompt.text }],
        metadata: activationPrompt.metadata,
      }],
    } as unknown as SessionHooks["context"]);
    expect(system.some((part) => part.type === "text" && part.text.includes("opencode-sherpa:caveman-mode"))).toBe(true);
    expect(await readFile(agentsPath, "utf8")).toBe(agentsContents);
    expect(await readFile(configPath, "utf8")).toBe(configContents);

    await cleanup?.();
    cleanup = undefined;
    expect(disposed).toEqual([
      "session.context",
      "session.prompt",
      "command.transform",
      "agent.transform",
      "skill.transform",
      "mcp.transform",
      "permission.evaluate",
      "session.context",
    ]);

    const registrationFailure = new Error("Command transform failed after opt-in registration.");
    const rollbackDisposed: string[] = [];
    const rollbackRuntime = runtimeDomains(rollbackDisposed, registrationFailure);
    const rollbackSkills = new Map<string, SkillInfo>();
    const rollbackContext = {
      options: { cavemanInstall: true },
      session: {
        hook: async (_name: "context" | "prompt") => ({
          dispose: async () => { rollbackDisposed.push("session.context"); },
        }),
      },
      permission: {
        hook: async () => ({ dispose: async () => { rollbackDisposed.push("permission.evaluate"); } }),
      },
      mcp: {
        transform: async () => ({ dispose: async () => { rollbackDisposed.push("mcp.transform"); } }),
      },
      skill: {
        transform: async (callback: (editor: SkillEditor) => void) => {
          callback({
            get: (id: string) => rollbackSkills.get(id),
            add: (skill: SkillInfo) => { rollbackSkills.set(String(skill.id), skill); },
          } as unknown as SkillEditor);
          return { dispose: async () => { rollbackDisposed.push("skill.transform"); } };
        },
      },
      ...rollbackRuntime.api,
    } as unknown as Context;

    await expect(SherpaPlugin.setup(rollbackContext)).rejects.toBe(registrationFailure);
    expect(rollbackDisposed).toEqual([
      "agent.transform",
      "skill.transform",
      "mcp.transform",
      "permission.evaluate",
      "session.context",
    ]);
    expect(await readFile(agentsPath, "utf8")).toBe(agentsContents);
    expect(await readFile(configPath, "utf8")).toBe(configContents);
  } finally {
    await cleanup?.();
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    if (root) await rm(root, { recursive: true, force: true });
    releaseFixture();
  }
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
  requireNode18();
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
      options: { hostSync: true, cavemanInstall: true },
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
