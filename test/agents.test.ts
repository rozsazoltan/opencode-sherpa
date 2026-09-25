import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentEditor } from "@opencode/plugin/promise/agent";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { Registration } from "@opencode/plugin/promise/registration";
import { CAVECREW_AGENT_NAMES, registerCavecrewAgents } from "../src/agents.ts";

type MutableAgent = Parameters<Parameters<AgentEditor["update"]>[1]>[0];

const INSTALLER_ROOT = fileURLToPath(new URL("../node_modules/caveman-installer/", import.meta.url));

function agentState(id: string): MutableAgent {
  return {
    id,
    name: id,
    request: { settings: {}, headers: {}, body: {} },
    mode: "primary",
    hidden: false,
    permissions: [],
  } as unknown as MutableAgent;
}

async function createPayload(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-sherpa-agents-"));
  await Promise.all([
    mkdir(path.join(root, "agents"), { recursive: true }),
    mkdir(path.join(root, "commands"), { recursive: true }),
    mkdir(path.join(root, "skills"), { recursive: true }),
    mkdir(path.join(root, "plugins/caveman"), { recursive: true }),
  ]);
  await writeFile(path.join(root, "AGENTS.md"), "# Isolated installer fixture\n");
  for (const name of CAVECREW_AGENT_NAMES) {
    await copyFile(
      path.join(INSTALLER_ROOT, "plugins/caveman/agents", `${name}.md`),
      path.join(root, "agents", `${name}.md`),
    );
  }

  const investigatorPath = path.join(root, "agents/cavecrew-investigator.md");
  const investigator = await readFile(investigatorPath, "utf8");
  await writeFile(investigatorPath, investigator.replace("Caveman-ultra.", "Fixture-specific investigator instructions."));

  const builderPath = path.join(root, "agents/cavecrew-builder.md");
  const builder = await readFile(builderPath, "utf8");
  await writeFile(builderPath, builder.replace(
    /^description: >\r?\n(?:[ \t]+.*\r?\n)+/mu,
    'description: "Installer-normalized builder description"\n',
  ));
  return root;
}

async function setupAgents(installedRoot: string, existing = new Map<string, MutableAgent>()) {
  const agents = new Map(existing);
  const added: string[] = [];
  let disposed = false;
  let transformCalls = 0;
  const editor = {
    get: (id: string) => agents.get(id),
    update: (id: string, update: Parameters<AgentEditor["update"]>[1]) => {
      const agent = agentState(id);
      update(agent);
      agents.set(id, agent);
      added.push(id);
    },
  } as unknown as AgentEditor;
  const context = {
    agent: {
      transform: async (callback: (editor: AgentEditor) => void): Promise<Registration> => {
        transformCalls += 1;
        callback(editor);
        return { dispose: async () => { disposed = true; } };
      },
    },
  };

  return {
    agents,
    added,
    registration: await registerCavecrewAgents(context as unknown as Pick<Context, "agent">, installedRoot),
    wasDisposed: () => disposed,
    transformCalls: () => transformCalls,
  };
}

test("registers fixture Cavecrew agents with conservative OpenCode-safe instructions", async () => {
  const root = await createPayload();
  try {
    const result = await setupAgents(root);

    expect(result.added.sort()).toEqual([...CAVECREW_AGENT_NAMES].sort());
    for (const name of CAVECREW_AGENT_NAMES) {
      const agent = result.agents.get(name);
      expect(agent?.mode).toBe("subagent");
      expect(agent?.description).toBeTruthy();
      expect(agent?.system).toBeTruthy();
    }

    const investigator = result.agents.get("cavecrew-investigator");
    expect(investigator?.description).toContain("Read-only code locator");
    expect(investigator?.system).toContain("Fixture-specific investigator instructions.");
    expect(investigator?.system).toContain("Shell is unavailable; use only read-only search and file tools.");
    expect(investigator?.system).not.toContain("`Bash` for `git log -S`");
    expect(investigator?.permissions).toEqual([
      { action: "edit", resource: "*", effect: "deny" },
      { action: "shell", resource: "*", effect: "deny" },
    ]);

    const reviewer = result.agents.get("cavecrew-reviewer");
    expect(reviewer?.system).toContain("Review only the diff or file excerpts supplied by the parent prompt.");
    expect(reviewer?.system).not.toContain("`Bash` only for `git diff`");
    expect(reviewer?.permissions).toEqual([
      { action: "edit", resource: "*", effect: "deny" },
      { action: "shell", resource: "*", effect: "deny" },
    ]);

    expect(result.agents.get("cavecrew-builder")?.permissions).toEqual([
      { action: "shell", resource: "*", effect: "deny" },
    ]);
    expect(result.agents.get("cavecrew-builder")?.description).toBe("Installer-normalized builder description");
    await result.registration.dispose();
    expect(result.wasDisposed()).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("leaves colliding Cavecrew agents untouched and only updates missing names", async () => {
  const root = await createPayload();
  try {
    const collision = agentState("cavecrew-builder");
    collision.description = "Owned by another source.";
    const result = await setupAgents(root, new Map([["cavecrew-builder", collision]]));

    expect(result.agents.get("cavecrew-builder")).toBe(collision);
    expect(result.agents.get("cavecrew-builder")?.description).toBe("Owned by another source.");
    expect(result.added.sort()).toEqual(
      CAVECREW_AGENT_NAMES.filter((name) => name !== "cavecrew-builder").sort(),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed when an installed agent asset is missing", async () => {
  const root = await createPayload();
  try {
    await rm(path.join(root, "agents/cavecrew-builder.md"));
    let transformCalls = 0;
    const context = {
      agent: {
        transform: async () => {
          transformCalls += 1;
          return { dispose: async () => {} };
        },
      },
    };

    await expect(registerCavecrewAgents(context as unknown as Pick<Context, "agent">, root)).rejects.toThrow();
    expect(transformCalls).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
