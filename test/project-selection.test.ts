import { expect, test } from "bun:test";
import type { SherpaOmoAgent } from "../src/agent-sources.ts";
import { detectProject } from "../src/project-detection.ts";
import { configuredContentSelection, selectProjectContent, selectProjectSkillIds } from "../src/project-selection.ts";
import type { PackagedCommand, PackagedInstruction, PackagedSkill, SherpaTuning } from "../src/tuning.ts";
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

function command(name: string): PackagedCommand {
  return { name, template: `Run ${name}.`, path: `commands/${name}.md` };
}

function instruction(id: string): PackagedInstruction {
  return { id, content: `Guidance for ${id}.`, path: `instructions/${id}.md` };
}

function tuning(
  skills: readonly PackagedSkill[],
  commands: readonly PackagedCommand[] = [],
  instructions: readonly PackagedInstruction[] = [],
): SherpaTuning {
  return { instructions, skills, commands };
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

test("auto-selects curated agent basenames but keeps original Sherpa skills explicit-only", () => {
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
  expect(result.skills).toEqual([]);
  expect(result.reasons).toHaveLength(7);
  expect(result.reasons.every(({ reason }) => reason.startsWith("Matched detected "))).toBe(true);
});

const upstreamSkillIds = [
  "sherpa-asyraf-php-best-practices",
  "sherpa-leonardomso-rust-skills",
  "sherpa-nuno-laravel-best-practices",
  "sherpa-nuno-fortify-development",
  "sherpa-nuno-wayfinder-development",
  "sherpa-antfu-pnpm",
  "sherpa-antfu-vite",
  "sherpa-antfu-vitest",
  "sherpa-antfu-vue",
  "sherpa-antfu-nuxt",
  "sherpa-antfu-pinia",
  "sherpa-antfu-unocss",
  "sherpa-antfu-vitepress",
];

test("auto-selects only available upstream skills matched by stack and exact features", () => {
  const cases = [
    [{ stacks: ["php"], features: [] }, "sherpa-asyraf-php-best-practices"],
    [{ stacks: ["rust"], features: [] }, "sherpa-leonardomso-rust-skills"],
    [{ stacks: [], features: ["laravel"] }, "sherpa-nuno-laravel-best-practices"],
    [{ stacks: [], features: ["fortify"] }, "sherpa-nuno-fortify-development"],
    [{ stacks: [], features: ["wayfinder"] }, "sherpa-nuno-wayfinder-development"],
    [{ stacks: [], features: ["pnpm"] }, "sherpa-antfu-pnpm"],
    [{ stacks: [], features: ["vite"] }, "sherpa-antfu-vite"],
    [{ stacks: [], features: ["vitest"] }, "sherpa-antfu-vitest"],
    [{ stacks: [], features: ["vue"] }, "sherpa-antfu-vue"],
    [{ stacks: [], features: ["nuxt"] }, "sherpa-antfu-nuxt"],
    [{ stacks: [], features: ["pinia"] }, "sherpa-antfu-pinia"],
    [{ stacks: [], features: ["unocss"] }, "sherpa-antfu-unocss"],
    [{ stacks: [], features: ["vitepress"] }, "sherpa-antfu-vitepress"],
  ] as const;

  for (const [detection, expected] of cases) {
    expect(selectProjectSkillIds(detection, upstreamSkillIds)).toEqual([expected]);
  }
  expect(selectProjectSkillIds({ stacks: ["php"], features: [] }, ["sherpa-antfu-vite"])).toEqual([]);
  expect(selectProjectSkillIds({ stacks: ["php"], features: [] }, [])).toEqual([]);
});

test("keeps optional upstream and original Sherpa skills manual-only", () => {
  const optionalIds = [
    "sherpa-antfu-antfu",
    "sherpa-antfu-antfu-create-pr",
    "sherpa-superpowers-test-driven-development",
    "sherpa-superpowers-systematic-debugging",
    "sherpa-superpowers-verification-before-completion",
    "sherpa-superpowers-brainstorming",
  ];
  const available = [...optionalIds, ...curatedSkills.map(({ id }) => id)];
  const detection = { stacks: ["php", "js", "rust"] as const, features: ["laravel", "vue"] };

  expect(selectProjectSkillIds(detection, available)).toEqual([]);
  expect(selectProjectSkillIds(detection, available, { include: ["sherpa-php-development"] }))
    .toEqual(["sherpa-php-development"]);
  expect(selectProjectSkillIds(detection, available, { include: ["sherpa-antfu-antfu"] }))
    .toEqual(["sherpa-antfu-antfu"]);
  expect(selectProjectSkillIds(detection, optionalIds)).toEqual([]);

  const emptyDetection = { stacks: [], features: [] };
  expect(selectProjectSkillIds(emptyDetection, available)).toEqual([]);
  expect(selectProjectSkillIds(emptyDetection, available, { auto: false, include: ["sherpa-issue-writing"] }))
    .toEqual(["sherpa-issue-writing"]);

  const disabledDetection = detectProject("/not/a/project", { enabled: false });
  expect(selectProjectSkillIds(disabledDetection, available)).toEqual([]);
  expect(selectProjectSkillIds(disabledDetection, available, { include: ["sherpa-issue-writing"] }))
    .toEqual(["sherpa-issue-writing"]);
});

test("shares strict skill selection rules with resolved packaged content", () => {
  const detection = { stacks: ["php"] as const, features: ["laravel"] };
  const available = ["sherpa-php-development", "sherpa-nuno-laravel-best-practices", "optional-skill"];
  const options = {
    include: ["optional-skill", "sherpa-php-development"],
    exclude: ["sherpa-php-development", "sherpa-nuno-laravel-best-practices"],
  };
  const resolved = selectProjectContent(
    detection,
    [],
    tuning(available.map(skill)),
    { skills: options },
  ).skills.map(({ id }) => id);

  expect(selectProjectSkillIds(detection, available, options)).toEqual(resolved);
  expect(resolved).toEqual(["optional-skill"]);
  expect(() => selectProjectSkillIds(detection, [], { include: ["sherpa-missing"] })).toThrow("Unknown skill ID");
  expect(() => selectProjectSkillIds(detection, [], { exclude: ["sherpa-missing"] })).toThrow("Unknown skill ID");
  expect(() => selectProjectContent(detection, [], tuning([]), { skills: { include: ["sherpa-missing"] } }))
    .toThrow("Unknown skill ID");
  expect(() => selectProjectContent(detection, [], tuning([]), { skills: { exclude: ["sherpa-missing"] } }))
    .toThrow("Unknown skill ID");
  expect(() => selectProjectSkillIds(detection, ["same", "same"])).toThrow("Duplicate skill ID");
  expect(() => selectProjectContent(detection, [], tuning([skill("same"), skill("same")]))).toThrow("Duplicate skill ID");
  expect(() => selectProjectSkillIds(detection, ["same"], { include: ["same", "same"] })).toThrow("duplicate ID");
  expect(() => selectProjectSkillIds(detection, ["same"], { unknown: true })).toThrow("Unsupported content selection field");
});

test("skill selection ordering does not depend on available source ordering", () => {
  const detection = { stacks: ["php", "rust"] as const, features: ["laravel", "vite"] };
  const available = [...upstreamSkillIds].reverse();
  const first = selectProjectSkillIds(detection, available);
  const second = selectProjectSkillIds(detection, [...available].reverse());

  expect(first).toEqual(second);
  expect(first).toEqual([
    "sherpa-asyraf-php-best-practices",
    "sherpa-antfu-vite",
    "sherpa-leonardomso-rust-skills",
    "sherpa-nuno-laravel-best-practices",
  ].sort());
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

test("auto-selects only matching stack commands and instructions plus common guidance", () => {
  const commands = [command("sherpa-write-pr"), command("sherpa-rust-check"), command("sherpa-js-check"),
    command("sherpa-php-check"), command("sherpa-write-issue")];
  const instructions = [instruction("30-rust-development"), instruction("00-sherpa-principles"),
    instruction("20-php-development"), instruction("10-js-development")];
  const stacks = ["js", "php", "rust"] as const;

  for (const [stack, expectedCommand, expectedInstruction] of [
    ["js", "sherpa-js-check", "10-js-development"],
    ["php", "sherpa-php-check", "20-php-development"],
    ["rust", "sherpa-rust-check", "30-rust-development"],
  ] as const) {
    const result = selectProjectContent(
      { stacks: [stack], features: [] },
      [],
      tuning([], commands, instructions),
    );
    expect(result.commands.map(({ name }) => name)).toEqual([expectedCommand]);
    expect(result.instructions.map(({ id }) => id)).toEqual(["00-sherpa-principles", expectedInstruction]);
    expect(result.reasons.find(({ id }) => id === "00-sherpa-principles")?.reason).toBe("Common project guidance.");
  }

  const mixed = selectProjectContent(
    { stacks, features: [] },
    [],
    tuning([], commands, instructions),
  );
  expect(mixed.commands.map(({ name }) => name)).toEqual(["sherpa-js-check", "sherpa-php-check", "sherpa-rust-check"]);
  expect(mixed.instructions.map(({ id }) => id)).toEqual([
    "00-sherpa-principles", "10-js-development", "20-php-development", "30-rust-development",
  ]);
});

test("common guidance remains on empty projects, while auto-off allows manual selection only", () => {
  const items = tuning([], [command("sherpa-js-check"), command("sherpa-write-issue")], [
    instruction("00-sherpa-principles"), instruction("10-js-development"), instruction("55-extra-guidance"),
  ]);
  const empty = selectProjectContent({ stacks: [], features: [] }, [], items);
  expect(empty.commands).toEqual([]);
  expect(empty.instructions.map(({ id }) => id)).toEqual(["00-sherpa-principles"]);

  const manual = selectProjectContent({ stacks: ["js"], features: [] }, [], items, {
    commands: { auto: false, include: ["sherpa-write-issue"] },
    instructions: { auto: false, include: ["55-extra-guidance"], exclude: ["00-sherpa-principles"] },
  });
  expect(manual.commands.map(({ name }) => name)).toEqual(["sherpa-write-issue"]);
  expect(manual.instructions.map(({ id }) => id)).toEqual(["55-extra-guidance"]);
  expect(manual.reasons.map(({ kind, id, reason }) => [kind, id, reason])).toEqual([
    ["command", "sherpa-write-issue", "Explicitly included."],
    ["instruction", "55-extra-guidance", "Explicitly included."],
  ]);
});

test("applies excludes before explicit includes and validates command and instruction IDs", () => {
  const items = tuning([], [command("sherpa-js-check"), command("sherpa-write-issue")], [
    instruction("00-sherpa-principles"), instruction("55-extra-guidance"),
  ]);
  const excluded = selectProjectContent({ stacks: ["js"], features: [] }, [], items, {
    commands: { include: ["sherpa-js-check"], exclude: ["sherpa-js-check"] },
    instructions: { include: ["55-extra-guidance"], exclude: ["55-extra-guidance"] },
  });
  expect(excluded.commands).toEqual([]);
  expect(excluded.instructions.map(({ id }) => id)).toEqual(["00-sherpa-principles"]);

  expect(() => selectProjectContent({ stacks: [], features: [] }, [], items, {
    commands: { include: ["missing-command"] },
  })).toThrow("Unknown command ID");
  expect(() => selectProjectContent({ stacks: [], features: [] }, [], items, {
    instructions: { exclude: ["missing-instruction"] },
  })).toThrow("Unknown instruction ID");
  expect(() => selectProjectContent(
    { stacks: [], features: [] }, [], tuning([], [command("same"), command("same")]),
  )).toThrow("Duplicate command ID");
  expect(() => selectProjectContent(
    { stacks: [], features: [] }, [], tuning([], [], [instruction("same"), instruction("same")]),
  )).toThrow("Duplicate instruction ID");
  expect(() => selectProjectContent({ stacks: [], features: [] }, [], items, { instructions: { include: [], extra: true } }))
    .toThrow("Unsupported content selection field 'extra'");
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

test("shipped tuning assets load and auto-select only matching language material", () => {
  const loaded = loadSherpaTuning();
  expect(loaded.instructions.map(({ id }) => id)).toEqual([
    "00-sherpa-principles", "10-js-development", "20-php-development", "30-rust-development",
  ]);
  expect(loaded.commands.map(({ name }) => name)).toEqual([
    "sherpa-js-check", "sherpa-php-check", "sherpa-rust-check", "sherpa-write-issue", "sherpa-write-pr",
  ]);
  expect(loaded.instructions.every(({ content }) => content.trim().length > 0)).toBe(true);
  expect(loaded.commands.every(({ template }) => template.trim().length > 0)).toBe(true);

  const result = selectProjectContent({ stacks: ["js"], features: [] }, [], loaded);
  expect(result.commands.map(({ name }) => name)).toEqual(["sherpa-js-check"]);
  expect(result.instructions.map(({ id }) => id)).toEqual(["00-sherpa-principles", "10-js-development"]);
});
