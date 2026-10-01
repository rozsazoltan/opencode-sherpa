import { expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { parse as parseJsonc } from "jsonc-parser";
import {
  configuredSherpaAgentSources,
  defaultSherpaAgentCacheDirectory,
  resolveSherpaAgentSources,
} from "../src/agent-sources.ts";
import { DEFAULT_SHERPA_AGENT_SOURCES } from "../src/agent-source-catalog.ts";
import { reconcileSherpaOmoAgents } from "../src/omo-agents.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "sherpa-omo-agent-test-"));
  const write = (relative: string, contents: string) => {
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
    return target;
  };
  return { root, write, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

function agent(id: string) {
  return {
    id,
    description: `Description for ${id}.`,
    orchestratorPrompt: `Delegate suitable work to @${id}.`,
    prompt: `# ${id}\n\nDo focused work.`,
    sourceNamespace: "fixture",
    sourceRepository: "example/agents",
    sourceCommit: COMMIT,
    sourcePath: `agents/${id}.md`,
  };
}

function config(file: string): Record<string, any> {
  return parseJsonc(readFileSync(file, "utf8")) as Record<string, any>;
}

async function makeArchive(root: string): Promise<Buffer> {
  const archivePath = path.join(root, "source.tgz");
  await tar.c({
    cwd: path.join(root, "repository"),
    file: archivePath,
    gzip: true,
    prefix: `repository-${COMMIT}`,
  }, ["LICENSE", "categories"]);
  return readFileSync(archivePath);
}

test("pins defaults and accepts customizable source descriptors", () => {
  expect(DEFAULT_SHERPA_AGENT_SOURCES[0]?.commit).toBe("82b73821baa7a911d5b14cfb6da238b7f0db6b42");
  expect(DEFAULT_SHERPA_AGENT_SOURCES[0]?.directories).toContain("categories/02-language-specialists");
  expect(DEFAULT_SHERPA_AGENT_SOURCES[0]?.directories).toContain("categories/07-specialized-domains/api-documenter.md");
  expect(configuredSherpaAgentSources([])).toEqual([]);
  expect(configuredSherpaAgentSources({ includeDefaults: false, sources: [{
    repository: "owner/agents",
    commit: COMMIT,
    namespace: "custom",
    directories: ["prompts"],
  }] })).toHaveLength(1);
  expect(configuredSherpaAgentSources({ sources: [] })).toEqual(DEFAULT_SHERPA_AGENT_SOURCES);
  expect(defaultSherpaAgentCacheDirectory({ XDG_CACHE_HOME: "/tmp/sherpa-cache" }, "/home/test"))
    .toBe("/tmp/sherpa-cache/opencode/.sherpa/agent-sources");
});

test("resolves recursive source prompts, strips Claude metadata, and reuses verified cache", async () => {
  const root = fixture();
  try {
    root.write("repository/LICENSE", "MIT License\nPermission is hereby granted.\n");
    root.write("repository/categories/README.md", "Catalog text, not an agent.\n");
    root.write("repository/categories/01-core-development/api-designer.md", "# API designer for core work\n\nCore API review.\n");
    root.write("repository/categories/api-designer.md", [
      "---",
      "name: API Designer",
      "description: Design stable API contracts.",
      "tools: Read, Write",
      "model: claude-opus",
      "---",
      "# API Designer",
      "\nDesign versioned HTTP APIs.",
      "",
    ].join("\n"));
    root.write("repository/categories/02-language-specialists/api-designer.md", "# API designer for language work\n\nLanguage API review.\n");
    root.write("repository/categories/nested/php-pro.md", [
      "---",
      "description: PHP specialist.",
      "---",
      "# PHP",
      "\nReview PHP code.",
      "",
    ].join("\n"));
    const archive = await makeArchive(root.root);
    let fetchCount = 0;
    const fetchImpl = (async () => {
      fetchCount++;
      return new Response(archive, { status: 200 });
    }) as unknown as typeof fetch;
    const sources = [{
      repository: "example/agents",
      commit: COMMIT,
      namespace: "fixture",
      directories: ["categories", "categories/nested/php-pro.md"],
    }];
    const options = {
      cacheDirectory: path.join(root.root, "cache"),
      fetchImpl,
    };

    const first = await resolveSherpaAgentSources(sources, options);
    expect(first.diagnostics).toEqual([]);
    expect(first.agents.map(({ id }) => id)).toEqual([
      "sherpa-fixture-api-designer",
      "sherpa-fixture-core-development-api-designer",
      "sherpa-fixture-language-specialists-api-designer",
      "sherpa-fixture-php-pro",
    ]);
    expect(first.agents[0]).toMatchObject({
      description: "Design stable API contracts.",
      prompt: "# API Designer\n\nDesign versioned HTTP APIs.",
      sourcePath: "categories/api-designer.md",
    });
    expect(JSON.stringify(first.agents[0])).not.toContain("claude-opus");
    expect(JSON.stringify(first.agents[0])).not.toContain("Read, Write");
    expect(first.sources[0]?.licenseText).toContain("MIT License");
    expect(fetchCount).toBe(1);

    const cached = await resolveSherpaAgentSources(sources, {
      ...options,
      fetchImpl: (async () => { throw new Error("Cache should avoid network."); }) as unknown as typeof fetch,
    });
    expect(cached.agents).toEqual(first.agents);
    expect(cached.sources[0]?.cacheHit).toBe(true);
    expect(fetchCount).toBe(1);
  } finally {
    root.dispose();
  }
});

test("empty source list resolves successfully without creating a cache", async () => {
  const root = fixture();
  try {
    expect(await resolveSherpaAgentSources([], { cacheDirectory: path.join(root.root, "cache") }))
      .toEqual({ agents: [], sources: [], diagnostics: [] });
    expect(() => readFileSync(path.join(root.root, "cache"))).toThrow();
    expect(reconcileSherpaOmoAgents({ agents: [], sources: [], diagnostics: [] }, { projectDirectory: root.root }))
      .toMatchObject({ skipped: false, removedAgents: [], installedAgents: [], removedPrompts: [] });
    expect(() => readFileSync(path.join(root.root, ".opencode"))).toThrow();
  } finally {
    root.dispose();
  }
});

test("rebuilds project-local Sherpa agents and preserves unrelated config and files", () => {
  const root = fixture();
  try {
    const projectConfigDirectory = path.join(root.root, ".opencode");
    const prompts = path.join(projectConfigDirectory, "oh-my-opencode-slim");
    mkdirSync(prompts, { recursive: true });
    const configPath = root.write(".opencode/oh-my-opencode-slim.jsonc", [
      "{",
      "  // Preserve comments and user configuration.",
      '  "theme": "dark",',
      '  "agents": { "designer": { "model": "user/designer" }, "sherpa-fixture-old": { "model": "old" }, "sherpa-fixture-obsolete": { "model": "stale" } },',
      '  "presets": {',
      '    "codex": { "designer": { "model": "codex/designer" }, "sherpa-fixture-old": { "model": "old" }, "sherpa-fixture-obsolete": { "model": "stale" } },',
      '    "session": { "designer": { "inheritModelFrom": "session" }, "sherpa-fixture-old": { "inheritModelFrom": "session" }, "sherpa-fixture-obsolete": { "inheritModelFrom": "session" } },',
      '    "custom": { "model": "custom/model", "sherpa-fixture-old": { "model": "old" }, "sherpa-fixture-obsolete": { "model": "stale" } }',
      "  },",
      '  "mcp": { "existing": true },',
      '  "skills": ["user-skill"]',
      "}",
    ].join("\n"));
    const oldPrompt = root.write(".opencode/oh-my-opencode-slim/sherpa-fixture-old.md", "User-modified stale prompt.\n");
    const obsoletePrompt = root.write(".opencode/oh-my-opencode-slim/sherpa-fixture-obsolete.md", "Obsolete prompt.\n");
    root.write(".opencode/oh-my-opencode-slim/other.md", "Unrelated prompt.\n");
    root.write(".opencode/oh-my-opencode-slim/notes.json", "{\"keep\":true}\n");
    root.write(".opencode/oh-my-opencode-slim/sherpa-folder/child.md", "Do not traverse prompt subdirectories.\n");
    const sourceNoticePath = root.write(".opencode/oh-my-opencode-slim/sherpa-agent-sources.md", "Keep existing notice.\n");
    const globalConfig = root.write("global/config/oh-my-opencode-slim.jsonc", '{"agents":{"sherpa-global":{"model":"global"}}}\n');
    const globalPrompt = root.write("global/config/oh-my-opencode-slim/sherpa-global.md", "Global sentinel.\n");
    const sources = [{
      namespace: "fixture",
      repository: "example/agents",
      commit: COMMIT,
      cacheHit: true,
      archiveSha256: "a".repeat(64),
      licensePath: "LICENSE",
      licenseText: "MIT License\nAll rights reserved by upstream authors.",
    }];
    const specialist = agent("sherpa-fixture-old");
    const resolution = { agents: [specialist], sources, diagnostics: [] };

    const first = reconcileSherpaOmoAgents(resolution, { projectDirectory: root.root });
    expect(first).toMatchObject({ skipped: false, installedAgents: [specialist.id], removedPrompts: ["sherpa-fixture-obsolete.md"] });
    const updatedText = readFileSync(configPath, "utf8");
    const updated = config(configPath);
    expect(updatedText).toContain("// Preserve comments and user configuration.");
    expect(updated).toMatchObject({
      theme: "dark",
      mcp: { existing: true },
      skills: ["user-skill"],
      agents: {
        designer: { model: "user/designer" },
        [specialist.id]: {
          description: specialist.description,
          orchestratorPrompt: specialist.orchestratorPrompt,
        },
      },
      presets: {
        codex: {
          designer: { model: "codex/designer" },
          [specialist.id]: { inheritModelFrom: "session" },
        },
        session: {
          designer: { inheritModelFrom: "session" },
          [specialist.id]: { inheritModelFrom: "session" },
        },
        custom: { "model": "custom/model" },
      },
    });
    expect(updated.agents["sherpa-fixture-old"]).toEqual({
      description: specialist.description,
      orchestratorPrompt: specialist.orchestratorPrompt,
    });
    expect(updated.presets.codex["sherpa-fixture-old"]).toEqual({ inheritModelFrom: "session" });
    expect(updated.presets.session["sherpa-fixture-old"]).toEqual({ inheritModelFrom: "session" });
    expect(updated.agents["sherpa-fixture-obsolete"]).toBeUndefined();
    expect(updated.presets.codex["sherpa-fixture-obsolete"]).toBeUndefined();
    expect(updated.presets.session["sherpa-fixture-obsolete"]).toBeUndefined();
    expect(updated.presets.custom["sherpa-fixture-old"]).toBeUndefined();
    expect(readFileSync(path.join(prompts, `${specialist.id}.md`), "utf8"))
      .toBe(`${specialist.prompt}\n`);
    expect(readFileSync(oldPrompt, "utf8")).toBe(`${specialist.prompt}\n`);
    expect(() => readFileSync(obsoletePrompt)).toThrow();
    expect(readFileSync(sourceNoticePath, "utf8")).toBe("Keep existing notice.\n");
    expect(readFileSync(path.join(prompts, "other.md"), "utf8")).toBe("Unrelated prompt.\n");
    expect(readFileSync(path.join(prompts, "notes.json"), "utf8")).toBe('{"keep":true}\n');
    expect(readFileSync(path.join(prompts, "sherpa-folder", "child.md"), "utf8"))
      .toBe("Do not traverse prompt subdirectories.\n");
    expect(readFileSync(globalConfig, "utf8")).toContain("sherpa-global");
    expect(readFileSync(globalPrompt, "utf8")).toBe("Global sentinel.\n");

    const before = [
      updatedText,
      readFileSync(path.join(prompts, `${specialist.id}.md`), "utf8"),
      readFileSync(sourceNoticePath, "utf8"),
    ];
    expect(reconcileSherpaOmoAgents(resolution, { projectDirectory: root.root }).skipped).toBe(false);
    expect([
      readFileSync(configPath, "utf8"),
      readFileSync(path.join(prompts, `${specialist.id}.md`), "utf8"),
      readFileSync(sourceNoticePath, "utf8"),
    ]).toEqual(before);
  } finally {
    root.dispose();
  }
});

test("removes stale Sherpa data when sources are intentionally empty", () => {
  const root = fixture();
  try {
    const configPath = root.write(".opencode/oh-my-opencode-slim.json", '{"agents":{"sherpa-fixture-reviewer":{"description":"User"},"reviewer":{"model":"keep"}},"presets":{"custom":{"sherpa-fixture-reviewer":{"model":"user"},"reviewer":{"model":"keep"}}}}\n');
    const promptPath = root.write(".opencode/oh-my-opencode-slim/sherpa-fixture-reviewer.md", "User-modified prompt.\n");
    const unrelated = root.write(".opencode/oh-my-opencode-slim/reviewer.md", "Keep.\n");
    const empty = { agents: [], sources: [], diagnostics: [] };
    const result = reconcileSherpaOmoAgents(empty, { projectDirectory: root.root });
    expect(result).toMatchObject({ skipped: false, removedAgents: ["sherpa-fixture-reviewer"], removedPrompts: ["sherpa-fixture-reviewer.md"] });
    expect(config(configPath)).toEqual({ agents: { reviewer: { model: "keep" } }, presets: { custom: { reviewer: { model: "keep" } } } });
    expect(() => readFileSync(promptPath)).toThrow();
    expect(readFileSync(unrelated, "utf8")).toBe("Keep.\n");
  } finally {
    root.dispose();
  }
});

test("source fetch failure skips cleanup and preserves existing project agents", async () => {
  const root = fixture();
  try {
    const configPath = root.write(".opencode/oh-my-opencode-slim.jsonc", '{"agents":{"sherpa-fixture-old":{"description":"old"}}}\n');
    const promptPath = root.write(".opencode/oh-my-opencode-slim/sherpa-fixture-old.md", "Keep until source recovers.\n");
    const before = [readFileSync(configPath, "utf8"), readFileSync(promptPath, "utf8")];
    const resolution = await resolveSherpaAgentSources([{
      namespace: "fixture",
      repository: "example/agents",
      commit: COMMIT,
      directories: ["agents"],
    }], {
      cacheDirectory: path.join(root.root, "cache"),
      fetchImpl: (async () => { throw new Error("Fetch failed."); }) as unknown as typeof fetch,
    });
    expect(resolution.diagnostics.map(({ code }) => code)).toEqual(["source-unavailable"]);
    const result = reconcileSherpaOmoAgents(resolution, { projectDirectory: root.root });
    expect(result).toMatchObject({ skipped: true, reason: "resolution-incomplete" });
    expect([readFileSync(configPath, "utf8"), readFileSync(promptPath, "utf8")]).toEqual(before);
  } finally {
    root.dispose();
  }
});

test("refuses ambiguous project-local config files without changing either", () => {
  const root = fixture();
  try {
    const jsonc = root.write(".opencode/oh-my-opencode-slim.jsonc", "{}\n");
    const json = root.write(".opencode/oh-my-opencode-slim.json", "{}\n");
    expect(() => reconcileSherpaOmoAgents({ agents: [agent("sherpa-fixture-reviewer")], sources: [], diagnostics: [] }, { projectDirectory: root.root }))
      .toThrow("Multiple OMO-Slim config files exist");
    expect(readFileSync(jsonc, "utf8")).toBe("{}\n");
    expect(readFileSync(json, "utf8")).toBe("{}\n");
  } finally {
    root.dispose();
  }
});

test("refuses linked project config and prompt paths without touching targets", () => {
  const root = fixture();
  try {
    const externalConfig = root.write("outside/oh-my-opencode-slim.jsonc", '{"agents":{"sherpa-outside":true}}\n');
    const configLink = path.join(root.root, ".opencode", "oh-my-opencode-slim.jsonc");
    mkdirSync(path.dirname(configLink), { recursive: true });
    symlinkSync(externalConfig, configLink);
    expect(() => reconcileSherpaOmoAgents({ agents: [agent("sherpa-fixture-reviewer")], sources: [], diagnostics: [] }, { projectDirectory: root.root }))
      .toThrow("Symlink path component is not allowed");
    expect(readFileSync(externalConfig, "utf8")).toBe('{"agents":{"sherpa-outside":true}}\n');

    rmSync(configLink);
    const outsidePrompts = path.join(root.root, "outside-prompts");
    mkdirSync(outsidePrompts);
    const outsidePrompt = root.write("outside-prompts/sherpa-outside.md", "Do not touch.\n");
    const promptLink = path.join(root.root, ".opencode", "oh-my-opencode-slim");
    symlinkSync(outsidePrompts, promptLink);
    expect(() => reconcileSherpaOmoAgents({ agents: [agent("sherpa-fixture-reviewer")], sources: [], diagnostics: [] }, { projectDirectory: root.root }))
      .toThrow("Symlink path component is not allowed");
    expect(readFileSync(outsidePrompt, "utf8")).toBe("Do not touch.\n");
  } finally {
    root.dispose();
  }
});

test("refuses linked Sherpa prompt files before changing config", () => {
  const root = fixture();
  try {
    const configPath = root.write(".opencode/oh-my-opencode-slim.jsonc", '{"agents":{"sherpa-fixture-old":true}}\n');
    const outsidePrompt = root.write("outside.md", "Outside sentinel.\n");
    const promptLink = path.join(root.root, ".opencode", "oh-my-opencode-slim", "sherpa-linked.md");
    mkdirSync(path.dirname(promptLink), { recursive: true });
    symlinkSync(outsidePrompt, promptLink);
    const originalConfig = readFileSync(configPath, "utf8");
    expect(() => reconcileSherpaOmoAgents({ agents: [agent("sherpa-fixture-new")], sources: [], diagnostics: [] }, { projectDirectory: root.root }))
      .toThrow("Symlink path component is not allowed");
    expect(readFileSync(configPath, "utf8")).toBe(originalConfig);
    expect(readFileSync(outsidePrompt, "utf8")).toBe("Outside sentinel.\n");
    expect(lstatSync(promptLink).isSymbolicLink()).toBe(true);
  } finally {
    root.dispose();
  }
});
