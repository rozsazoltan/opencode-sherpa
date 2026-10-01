import { expect, test } from "bun:test";
import type { SherpaOmoAgent } from "../src/agent-sources.ts";
import { configuredContentSelection, selectProjectContent } from "../src/project-selection.ts";
import type { PackagedSkill, SherpaTuning } from "../src/tuning.ts";
import { loadSherpaTuning } from "../src/tuning.ts";

function agent(id: string, sourcePath: string): SherpaOmoAgent {
  return {
    id,
    description: `Description for ${id}.`,
    orchestratorPrompt: `Delegate suitable work to @${id}.`,
    prompt: `# ${id}\n\nDo focused work.`,
    sourceNamespace: "fixture",
    sourceRepository: "example/agents",
    sourceCommit: "0".repeat(40),
    sourcePath,
  };
}

function skill(id: string): PackagedSkill {
  return { id, name: id, description: `Guidance for ${id}.`, path: `${id}/SKILL.md`, content: "Guidance." };
}

function tuning(skills: readonly PackagedSkill[]): SherpaTuning {
  return { instructions: [], skills, commands: [] };
}

const curatedAgents = [
  agent("sherpa-custom-php-pro", "categories/php-pro.md"),
  agent("sherpa-another-laravel-specialist", "nested/laravel-specialist.md"),
  agent("sherpa-fixture-javascript-pro", "js/javascript-pro.md"),
  agent("sherpa-fixture-typescript-pro", "typescript-pro.md"),
  agent("sherpa-fixture-vue-expert", "frameworks/vue-expert.md"),
  agent("sherpa-fixture-react-specialist", "react-specialist.md"),
  agent("sherpa-fixture-rust-engineer", "rust-engineer.md"),
  agent("sherpa-fixture-extra", "extra/manual-agent.md"),
];

const curatedSkills = [
  skill("sherpa-php-development"),
  skill("sherpa-js-development"),
  skill("sherpa-rust-development"),
  skill("sherpa-laravel-development"),
  skill("sherpa-vue-development"),
  skill("sherpa-issue-writing"),
  skill("sherpa-pr-writing"),
  skill("extra/optional-skill"),
];

test("content selection defaults to automatic discovery and validates strict configuration", () => {
  expect(configuredContentSelection(undefined)).toEqual({ auto: true, include: [], exclude: [] });
  expect(configuredContentSelection({ auto: false, include: ["sherpa-extra"], exclude: ["sherpa-old"] }))
    .toEqual({ auto: false, include: ["sherpa-extra"], exclude: ["sherpa-old"] });

  for (const invalid of [null, [], new Date(), "auto", { automatic: true }, { auto: "yes" }, { include: "sherpa-x" },
    { include: ["sherpa-x", "sherpa-x"] }, { exclude: ["../outside"] }, { include: ["Uppercase"] }]) {
    expect(() => configuredContentSelection(invalid)).toThrow();
  }
});

test("auto-selects curated agent basenames and stack/feature skills across source namespaces", () => {
  const result = selectProjectContent(
    { stacks: ["php", "js", "rust"], features: ["laravel", "typescript", "vue", "react"] },
    curatedAgents,
    tuning(curatedSkills),
  );

  expect(result.agents.map(({ id }) => id)).toEqual([
    "sherpa-another-laravel-specialist",
    "sherpa-custom-php-pro",
    "sherpa-fixture-javascript-pro",
    "sherpa-fixture-react-specialist",
    "sherpa-fixture-rust-engineer",
    "sherpa-fixture-typescript-pro",
    "sherpa-fixture-vue-expert",
  ]);
  expect(result.skills.map(({ id }) => id)).toEqual([
    "sherpa-js-development",
    "sherpa-laravel-development",
    "sherpa-php-development",
    "sherpa-rust-development",
    "sherpa-vue-development",
  ]);
  expect(result.reasons).toHaveLength(12);
  expect(result.reasons.every(({ reason }) => reason.startsWith("Matched detected "))).toBe(true);
});

test("explicit includes allow extras and auto-off while exclusions always win", () => {
  const result = selectProjectContent(
    { stacks: [], features: [] },
    curatedAgents,
    tuning(curatedSkills),
    {
      agents: { auto: false, include: ["sherpa-fixture-extra", "sherpa-custom-php-pro"], exclude: ["sherpa-custom-php-pro"] },
      skills: { auto: false, include: ["sherpa-issue-writing", "extra/optional-skill"], exclude: ["sherpa-issue-writing"] },
    },
  );

  expect(result.agents.map(({ id }) => id)).toEqual(["sherpa-fixture-extra"]);
  expect(result.skills.map(({ id }) => id)).toEqual(["extra/optional-skill"]);
  expect(result.reasons.map(({ reason }) => reason)).toEqual(["Explicitly included.", "Explicitly included."]);
});

test("rejects unknown requested IDs, malformed options, and duplicate discovered IDs", () => {
  expect(() => selectProjectContent({ stacks: [], features: [] }, [], tuning([]), {
    agents: { include: ["sherpa-missing"] },
  })).toThrow("Unknown agent ID");
  expect(() => selectProjectContent({ stacks: [], features: [] }, [], tuning([]), {
    skills: { include: ["sherpa-missing"] },
  })).toThrow("Unknown skill ID");
  expect(() => selectProjectContent({ stacks: [], features: [] }, [], tuning([]), { extra: true } as never))
    .toThrow("Unsupported project content selection option");
  expect(() => selectProjectContent({ stacks: [], features: [] }, [curatedAgents[0]!, curatedAgents[0]!], tuning([])))
    .toThrow("Duplicate agent ID");
});

test("selection and reasons are stable regardless of discovery order", () => {
  const detection = { stacks: ["rust", "js", "php"] as const, features: ["vue", "laravel"] };
  const first = selectProjectContent(detection, curatedAgents, tuning(curatedSkills));
  const second = selectProjectContent(
    { stacks: ["php", "js", "rust"], features: ["laravel", "vue"] },
    [...curatedAgents].reverse(),
    tuning([...curatedSkills].reverse()),
  );
  expect(second).toEqual(first);
});

test("all authored Sherpa skills load with valid metadata and non-empty guidance", () => {
  const loaded = loadSherpaTuning();
  const authored = loaded.skills.filter(({ id }) => id.startsWith("sherpa-"));
  expect(authored.map(({ id }) => id)).toEqual([
    "sherpa-issue-writing",
    "sherpa-js-development",
    "sherpa-laravel-development",
    "sherpa-php-development",
    "sherpa-pr-writing",
    "sherpa-rust-development",
    "sherpa-vue-development",
  ]);
  expect(authored.every(({ name, description, content }) => name.length > 0 && description.length > 0 && content.length > 0))
    .toBe(true);
  expect(authored.map(({ id, name }) => [id, name])).toEqual(authored.map(({ id }) => [id, id]));
});
