import { parse as parseYaml } from "yaml";
import { isRecord } from "./agent-files.ts";

export interface AgentPromptSource {
  readonly namespace: string;
  readonly repository: string;
  readonly commit: string;
}

export interface ParsedAgentPrompt {
  readonly id: string;
  readonly description: string;
  readonly orchestratorPrompt: string;
  readonly prompt: string;
  readonly sourceNamespace: string;
  readonly sourceRepository: string;
  readonly sourceCommit: string;
  readonly sourcePath: string;
}

function inferredDescription(id: string, prompt: string): string {
  const lines = prompt.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const heading = lines.find((line) => /^#{1,6}\s+/u.test(line));
  const candidate = (heading ?? lines[0] ?? id).replace(/^#{1,6}\s+/u, "").replace(/\s+/gu, " ").trim();
  const sentence = candidate.split(/(?<=[.!?])\s/u, 1)[0] ?? candidate;
  return sentence.length > 200 ? `${sentence.slice(0, 197).trimEnd()}...` : sentence;
}

export function parseAgentPrompt(
  raw: string,
  id: string,
  source: AgentPromptSource,
  relativePath: string,
): ParsedAgentPrompt {
  const text = raw.replace(/^\uFEFF/u, "");
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u.exec(text);
  let metadata: Record<string, unknown> = {};
  let prompt = text.trim();
  if (match) {
    let parsed: unknown;
    try {
      parsed = parseYaml(match[1] ?? "");
    } catch {
      throw new Error("Agent prompt frontmatter is malformed YAML.");
    }
    if (!isRecord(parsed)) throw new Error("Agent prompt frontmatter must be a YAML object.");
    metadata = parsed;
    prompt = text.slice(match[0].length).trim();
  } else if (/^---[ \t]*(?:\r?\n|$)/u.test(text)) {
    throw new Error("Agent prompt frontmatter has no closing delimiter.");
  }
  if (!prompt) throw new Error("Agent prompt body is empty.");

  const rawDescription = metadata.description;
  if (rawDescription !== undefined && (typeof rawDescription !== "string" || rawDescription.trim() === "")) {
    throw new Error("Agent prompt description must be a non-empty string.");
  }
  const description = typeof rawDescription === "string" ? rawDescription.trim() : inferredDescription(id, prompt);
  const rawOrchestratorPrompt = metadata.orchestratorPrompt;
  if (rawOrchestratorPrompt !== undefined &&
    (typeof rawOrchestratorPrompt !== "string" || rawOrchestratorPrompt.trim() === "")) {
    throw new Error("Agent prompt orchestratorPrompt must be a non-empty string.");
  }
  const orchestratorPrompt = typeof rawOrchestratorPrompt === "string"
    ? rawOrchestratorPrompt.trim()
    : `Delegate to @${id} for ${description}`;

  return {
    id,
    description,
    orchestratorPrompt,
    prompt,
    sourceNamespace: source.namespace,
    sourceRepository: source.repository,
    sourceCommit: source.commit,
    sourcePath: relativePath,
  };
}
