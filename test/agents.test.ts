import { expect, test } from "bun:test";
import type { AgentEditor } from "@opencode/plugin/promise/agent";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { Registration } from "@opencode/plugin/promise/registration";
import { CAVECREW_AGENT_NAMES, registerCavecrewAgents } from "../src/agents.ts";

type MutableAgent = Parameters<Parameters<AgentEditor["update"]>[1]>[0];

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

async function setupAgents(existing = new Map<string, MutableAgent>()) {
  const agents = new Map(existing);
  const added: string[] = [];
  let disposed = false;
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
        callback(editor);
        return { dispose: async () => { disposed = true; } };
      },
    },
  };

  return {
    agents,
    added,
    registration: await registerCavecrewAgents(context as unknown as Pick<Context, "agent">),
    wasDisposed: () => disposed,
  };
}

test("registers the three pinned Cavecrew agents with their OpenCode-safe instructions", async () => {
  const result = await setupAgents();

  expect(result.added.sort()).toEqual([...CAVECREW_AGENT_NAMES].sort());
  for (const name of CAVECREW_AGENT_NAMES) {
    const agent = result.agents.get(name);
    expect(agent?.mode).toBe("subagent");
    expect(agent?.description).toBeTruthy();
    expect(agent?.system).toBeTruthy();
  }

  const investigator = result.agents.get("cavecrew-investigator");
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
  await result.registration.dispose();
  expect(result.wasDisposed()).toBe(true);
});

test("leaves colliding Cavecrew agents untouched and only updates missing names", async () => {
  const collision = agentState("cavecrew-builder");
  collision.description = "Owned by another source.";
  const result = await setupAgents(new Map([["cavecrew-builder", collision]]));

  expect(result.agents.get("cavecrew-builder")).toBe(collision);
  expect(result.agents.get("cavecrew-builder")?.description).toBe("Owned by another source.");
  expect(result.added.sort()).toEqual(
    CAVECREW_AGENT_NAMES.filter((name) => name !== "cavecrew-builder").sort(),
  );
});
