import { isRecord } from "./agent-files.ts";

/** Immutable source selection. Repository accepts `owner/name` or a GitHub URL. */
export interface SherpaAgentSource {
  readonly repository: string;
  readonly commit: string;
  readonly directories: readonly string[];
  readonly namespace: string;
}

export const DEFAULT_SHERPA_AGENT_SOURCES: readonly SherpaAgentSource[] = [
  {
    repository: "VoltAgent/awesome-claude-code-subagents",
    commit: "82b73821baa7a911d5b14cfb6da238b7f0db6b42",
    namespace: "voltagent",
    directories: [
      "categories/01-core-development",
      "categories/02-language-specialists",
      "categories/04-quality-security",
      "categories/06-developer-experience",
      "categories/08-business-product",
      "categories/07-specialized-domains/api-documenter.md",
    ],
  },
];

/** Resolve plugin options into pinned source selections without loading or fetching any source. */
export function configuredSherpaAgentSources(value: unknown): readonly SherpaAgentSource[] {
  if (value === undefined) return DEFAULT_SHERPA_AGENT_SOURCES;
  if (Array.isArray(value)) return value as SherpaAgentSource[];
  if (!isRecord(value) || !Array.isArray(value.sources) ||
    (value.includeDefaults !== undefined && typeof value.includeDefaults !== "boolean")) {
    throw new TypeError("agentSources must be an array or an object with a sources array and optional includeDefaults boolean.");
  }
  return [
    ...(value.includeDefaults === false ? [] : DEFAULT_SHERPA_AGENT_SOURCES),
    ...(value.sources as SherpaAgentSource[]),
  ];
}
