import { expect, test } from "bun:test";
import { parseAgentPrompt } from "../src/agent-prompt.ts";

const source = {
  namespace: "fixture",
  repository: "example/agents",
  commit: "0123456789abcdef0123456789abcdef01234567",
};

test("adapts prompt frontmatter and retains source provenance", () => {
  const agent = parseAgentPrompt([
    "\uFEFF---",
    "description: Review Laravel authentication flows.",
    "orchestratorPrompt: Route auth work to this specialist.",
    "model: claude-opus",
    "tools: Read, Write",
    "---",
    "# Laravel Auth",
    "",
    "Review session and token boundaries.",
  ].join("\n"), "sherpa-fixture-laravel-auth", source, "agents/laravel-auth.md");

  expect(agent).toEqual({
    id: "sherpa-fixture-laravel-auth",
    description: "Review Laravel authentication flows.",
    orchestratorPrompt: "Route auth work to this specialist.",
    prompt: "# Laravel Auth\n\nReview session and token boundaries.",
    sourceNamespace: "fixture",
    sourceRepository: "example/agents",
    sourceCommit: source.commit,
    sourcePath: "agents/laravel-auth.md",
  });
});

test("infers a concise description and default routing prompt", () => {
  const agent = parseAgentPrompt(
    "# Rust Engineer\n\nReview ownership and concurrency.\n",
    "sherpa-fixture-rust-engineer",
    source,
    "agents/rust-engineer.md",
  );

  expect(agent.description).toBe("Rust Engineer");
  expect(agent.orchestratorPrompt).toBe("Delegate to @sherpa-fixture-rust-engineer for Rust Engineer");
  expect(agent.prompt).toBe("# Rust Engineer\n\nReview ownership and concurrency.");
});

test("rejects malformed, unclosed, and empty prompt documents", () => {
  expect(() => parseAgentPrompt("---\ndescription: [\n---\nPrompt", "sherpa-fixture-bad", source, "bad.md"))
    .toThrow("frontmatter is malformed YAML");
  expect(() => parseAgentPrompt("---\ndescription: Missing end", "sherpa-fixture-open", source, "open.md"))
    .toThrow("no closing delimiter");
  expect(() => parseAgentPrompt("---\ndescription: Present\n---\n  ", "sherpa-fixture-empty", source, "empty.md"))
    .toThrow("body is empty");
});
