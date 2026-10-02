export type ProjectStack = "php" | "js" | "rust";

export interface ProjectContentRule {
  readonly id: string;
  readonly stacks?: readonly ProjectStack[];
  readonly features?: readonly string[];
  readonly always?: boolean;
}

export const PROJECT_AGENT_CATALOG: readonly ProjectContentRule[] = [
  { id: "php-pro", stacks: ["php"] },
  { id: "laravel-specialist", features: ["laravel"] },
  { id: "javascript-pro", stacks: ["js"] },
  { id: "typescript-pro", features: ["typescript"] },
  { id: "vue-expert", features: ["vue"] },
  { id: "react-specialist", features: ["react"] },
  { id: "rust-engineer", stacks: ["rust"] },
];

export const PROJECT_SKILL_CATALOG: readonly ProjectContentRule[] = [
  { id: "sherpa-asyraf-php-best-practices", stacks: ["php"] },
  { id: "sherpa-leonardomso-rust-skills", stacks: ["rust"] },
  { id: "sherpa-nuno-laravel-best-practices", features: ["laravel"] },
  { id: "sherpa-nuno-fortify-development", features: ["fortify"] },
  { id: "sherpa-nuno-wayfinder-development", features: ["wayfinder"] },
  { id: "sherpa-antfu-pnpm", features: ["pnpm"] },
  { id: "sherpa-antfu-vite", features: ["vite"] },
  { id: "sherpa-antfu-vitest", features: ["vitest"] },
  { id: "sherpa-antfu-vue", features: ["vue"] },
  { id: "sherpa-antfu-nuxt", features: ["nuxt"] },
  { id: "sherpa-antfu-pinia", features: ["pinia"] },
  { id: "sherpa-antfu-unocss", features: ["unocss"] },
  { id: "sherpa-antfu-vitepress", features: ["vitepress"] },
];

export const PROJECT_COMMAND_CATALOG: readonly ProjectContentRule[] = [
  { id: "sherpa-js-check", stacks: ["js"] },
  { id: "sherpa-php-check", stacks: ["php"] },
  { id: "sherpa-rust-check", stacks: ["rust"] },
];

export const PROJECT_INSTRUCTION_CATALOG: readonly ProjectContentRule[] = [
  { id: "00-sherpa-principles", always: true },
  { id: "10-js-development", stacks: ["js"] },
  { id: "20-php-development", stacks: ["php"] },
  { id: "30-rust-development", stacks: ["rust"] },
];
