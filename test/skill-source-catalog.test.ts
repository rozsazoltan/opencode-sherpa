import { expect, test } from "bun:test";
import { configuredSherpaSkillSources, declaredSkillIds } from "../src/skill-sources.ts";
import { selectProjectSkillIds } from "../src/project-selection.ts";

test("default skill source catalog keeps full pins, license evidence, and unique IDs", () => {
  const sources = configuredSherpaSkillSources(undefined);
  const ids = declaredSkillIds(sources);

  expect(sources.map(({ namespace }) => namespace)).toEqual([
    "superpowers", "antfu", "nuno", "asyraf", "leonardomso", "mattpocock",
  ]);
  expect(sources).toHaveLength(6);
  expect(ids).toHaveLength(22);
  expect(new Set(ids).size).toBe(22);
  for (const { commit } of sources) expect(commit).toMatch(/^[a-f0-9]{40}$/u);

  expect(sources.find(({ namespace }) => namespace === "nuno")).toMatchObject({ license: "MIT" });
  expect(sources.find(({ namespace }) => namespace === "leonardomso")).toMatchObject({
    licensePath: "LICENSE",
    skills: [{ id: "rust-skills", path: "SKILL.md", supportPaths: ["rules"] }],
  });
  expect(sources.find(({ namespace }) => namespace === "mattpocock")).toEqual({
    namespace: "mattpocock",
    repository: "mattpocock/skills",
    commit: "d81f3a183412e71a5b1e84ca21bc1a35eea03a60",
    licensePath: "LICENSE",
    skills: [
      { id: "diagnosing-bugs", path: "skills/engineering/diagnosing-bugs/SKILL.md" },
      { id: "codebase-design", path: "skills/engineering/codebase-design/SKILL.md" },
      { id: "writing-for-agents", path: "skills/productivity/writing-for-agents/SKILL.md" },
    ],
  });
});

test("Matt Pocock skills remain manual-only for every detected stack", () => {
  const mattIds = [
    "sherpa-mattpocock-diagnosing-bugs",
    "sherpa-mattpocock-codebase-design",
    "sherpa-mattpocock-writing-for-agents",
  ];

  expect(selectProjectSkillIds({ stacks: ["php", "js", "rust"], features: ["laravel", "vue"] }, mattIds)).toEqual([]);
});
