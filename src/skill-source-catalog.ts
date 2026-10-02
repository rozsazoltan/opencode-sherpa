export interface SherpaSkillSourceEntry {
  readonly id: string;
  readonly path: string;
  readonly supportPaths?: readonly string[];
}

export interface SherpaSkillSource {
  readonly namespace: string;
  readonly repository: string;
  readonly commit: string;
  readonly licensePath?: string;
  readonly license?: string;
  readonly skills: readonly SherpaSkillSourceEntry[];
}

export const DEFAULT_SHERPA_SKILL_SOURCES: readonly SherpaSkillSource[] = [
  {
    namespace: "superpowers",
    repository: "obra/superpowers",
    commit: "8ca22dba9a94f28898bbce59f2537ff4d87c747d",
    licensePath: "LICENSE",
    skills: [
      { id: "test-driven-development", path: "skills/test-driven-development/SKILL.md" },
      { id: "systematic-debugging", path: "skills/systematic-debugging/SKILL.md" },
      { id: "verification-before-completion", path: "skills/verification-before-completion/SKILL.md" },
      { id: "brainstorming", path: "skills/brainstorming/SKILL.md" },
    ],
  },
  {
    namespace: "antfu",
    repository: "antfu/skills",
    commit: "e53a142a2420e8cd812cfe9ed0484ab01bc856aa",
    licensePath: "LICENSE.md",
    skills: [
      { id: "antfu", path: "skills/antfu/SKILL.md" },
      { id: "antfu-create-pr", path: "skills/antfu-create-pr/SKILL.md" },
      { id: "pnpm", path: "skills/pnpm/SKILL.md" },
      { id: "vite", path: "skills/vite/SKILL.md" },
      { id: "vitest", path: "skills/vitest/SKILL.md" },
      { id: "vue", path: "skills/vue/SKILL.md" },
      { id: "nuxt", path: "skills/nuxt/SKILL.md" },
      { id: "pinia", path: "skills/pinia/SKILL.md" },
      { id: "unocss", path: "skills/unocss/SKILL.md" },
      { id: "vitepress", path: "skills/vitepress/SKILL.md" },
    ],
  },
  {
    namespace: "nuno",
    repository: "nunomaduro/laravel-starter-kit-inertia-vue",
    commit: "ec84016bcd4209c11636962c4dd7a91c71cc68cc",
    license: "MIT",
    skills: [
      { id: "laravel-best-practices", path: ".agents/skills/laravel-best-practices/SKILL.md" },
      { id: "fortify-development", path: ".agents/skills/fortify-development/SKILL.md" },
      { id: "wayfinder-development", path: ".agents/skills/wayfinder-development/SKILL.md" },
    ],
  },
  {
    namespace: "asyraf",
    repository: "AsyrafHussin/agent-skills",
    commit: "1aa0ff717c10309226c9e678f00873976450fd76",
    licensePath: "LICENSE",
    skills: [
      { id: "php-best-practices", path: "skills/php-best-practices/SKILL.md" },
    ],
  },
  {
    namespace: "leonardomso",
    repository: "leonardomso/rust-skills",
    commit: "fd2a861ab0406a4ac536a55274d14ea6fd1ca9c9",
    licensePath: "LICENSE",
    skills: [
      { id: "rust-skills", path: "SKILL.md", supportPaths: ["rules"] },
    ],
  },
  {
    namespace: "mattpocock",
    repository: "mattpocock/skills",
    commit: "d81f3a183412e71a5b1e84ca21bc1a35eea03a60",
    licensePath: "LICENSE",
    skills: [
      { id: "diagnosing-bugs", path: "skills/engineering/diagnosing-bugs/SKILL.md" },
      { id: "codebase-design", path: "skills/engineering/codebase-design/SKILL.md" },
      { id: "writing-for-agents", path: "skills/productivity/writing-for-agents/SKILL.md" },
    ],
  },
];
