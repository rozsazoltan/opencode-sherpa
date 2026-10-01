export type ProjectStack = "php" | "js" | "rust";

export interface ProjectContentRule {
  readonly id: string;
  readonly stacks?: readonly ProjectStack[];
  readonly features?: readonly string[];
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
