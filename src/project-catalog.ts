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
  { id: "sherpa-php-development", stacks: ["php"] },
  { id: "sherpa-js-development", stacks: ["js"] },
  { id: "sherpa-rust-development", stacks: ["rust"] },
  { id: "sherpa-laravel-development", features: ["laravel"] },
  { id: "sherpa-vue-development", features: ["vue"] },
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
