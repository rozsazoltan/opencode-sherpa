import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { Registration } from "@opencode/plugin/promise/registration";

export const CAVECREW_AGENT_NAMES = [
  "cavecrew-investigator",
  "cavecrew-builder",
  "cavecrew-reviewer",
] as const;

const CAVEMAN_PACKAGE_ROOT = fileURLToPath(
  new URL(".", import.meta.resolve("caveman-installer/package.json")),
);

interface AgentDefinition {
  description: string;
  mode: "subagent";
  system: string;
  permissions: Array<{ action: string; resource: string; effect: "deny" }>;
}

async function loadAgentDefinition(name: (typeof CAVECREW_AGENT_NAMES)[number]): Promise<AgentDefinition> {
  const document = await readFile(path.join(CAVEMAN_PACKAGE_ROOT, "agents", `${name}.md`), "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(document);
  if (!match?.[1]?.includes(`name: ${name}`) || match[2] === undefined) {
    throw new Error(`Pinned Caveman agent ${name} has invalid frontmatter.`);
  }

  const description = /^description: >\r?\n((?:[ \t]+.*\r?\n)+)/mu.exec(match[1]);
  if (!description?.[1]) throw new Error(`Pinned Caveman agent ${name} has no description.`);

  let system = match[2];
  if (name === "cavecrew-reviewer") {
    const original = "`Bash` only for `git diff`/`git log -p`/`git show`. No mutating commands.";
    if (!system.includes(original)) throw new Error("Pinned Caveman reviewer instructions have changed.");
    system = system.replace(original,
      "Shell is unavailable. Review only the diff or file excerpts supplied by the parent prompt. If missing, request that material; never claim to have inspected Git state.");
  }
  if (name === "cavecrew-investigator") {
    const original = "`Bash` for `git log -S`/`git grep`/`find` when faster.";
    if (!system.includes(original)) throw new Error("Pinned Caveman investigator instructions have changed.");
    system = system.replace(original, "Shell is unavailable; use only read-only search and file tools.");
  }

  return {
    description: description[1].trim().replace(/\s+/gu, " "),
    mode: "subagent",
    system,
    permissions: name === "cavecrew-builder"
      ? [{ action: "shell", resource: "*", effect: "deny" }]
      : [
          { action: "edit", resource: "*", effect: "deny" },
          { action: "shell", resource: "*", effect: "deny" },
        ],
  };
}

async function loadAgentDefinitions(): Promise<Array<readonly [string, AgentDefinition]>> {
  return Promise.all(CAVECREW_AGENT_NAMES.map(async (name) => [name, await loadAgentDefinition(name)] as const));
}

export async function registerCavecrewAgents(
  ctx: Pick<Context, "agent">,
): Promise<Registration> {
  const definitions = await loadAgentDefinitions();

  return ctx.agent.transform((editor) => {
    for (const [name, definition] of definitions) {
      if (editor.get(name) !== undefined) continue;
      editor.update(name, (agent) => {
        agent.mode = definition.mode;
        agent.description = definition.description;
        agent.system = definition.system;
        agent.permissions = definition.permissions;
      });
    }
  });
}
