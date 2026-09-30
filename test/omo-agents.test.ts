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
import { syncSherpaOmoAgents } from "../src/omo-agents.ts";

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
      "sherpa-fixture-categories-api-designer",
      "sherpa-fixture-categories-nested-php-pro",
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

test("empty source list does not create cache or touch a config directory", async () => {
  const root = fixture();
  try {
    expect(await resolveSherpaAgentSources([], { cacheDirectory: path.join(root.root, "cache") }))
      .toEqual({ agents: [], sources: [], diagnostics: [] });
    expect(() => readFileSync(path.join(root.root, "cache"))).toThrow();
    expect(syncSherpaOmoAgents([], { configDirectory: path.join(root.root, "config") }).installed).toEqual([]);
    expect(() => readFileSync(path.join(root.root, "config"))).toThrow();
  } finally {
    root.dispose();
  }
});

test("syncs global OMO config safely and idempotently while retaining existing presets", () => {
  const root = fixture();
  try {
    const configDirectory = path.join(root.root, "config");
    mkdirSync(configDirectory, { recursive: true });
    const configPath = root.write("config/oh-my-opencode-slim.jsonc", [
      "{",
      "  // Keep this user comment.",
      '  "theme": "dark",',
      '  "agents": { "designer": { "model": "user/designer" } },',
      '  "presets": { "codex": { "designer": { "model": "codex/designer" } } },',
      '  "mcp": { "existing": true },',
      '  "skills": ["user-skill"]',
      "}",
    ].join("\n"));
    const originalCodex = config(configPath).presets.codex;
    const sources = [{
      namespace: "fixture",
      repository: "example/agents",
      commit: COMMIT,
      cacheHit: true,
      archiveSha256: "a".repeat(64),
      licensePath: "LICENSE",
      licenseText: "MIT License\nAll rights reserved by upstream authors.",
    }];
    const specialist = agent("sherpa-fixture-api-designer");

    const first = syncSherpaOmoAgents([specialist], { configDirectory, sources });
    expect(first.installed).toEqual([specialist.id]);
    expect(first.collisions).toEqual([]);
    const updatedText = readFileSync(configPath, "utf8");
    const updated = config(configPath);
    expect(updatedText).toContain("// Keep this user comment.");
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
        codex: originalCodex,
        session: {
          designer: { inheritModelFrom: "session" },
          [specialist.id]: { inheritModelFrom: "session" },
        },
      },
    });
    expect(updated.presets.codex[specialist.id]).toEqual({ inheritModelFrom: "session" });
    expect(updated.presets.codex.designer).toEqual({ model: "codex/designer" });
    expect(readFileSync(path.join(configDirectory, "oh-my-opencode-slim", `${specialist.id}.md`), "utf8"))
      .toBe(`${specialist.prompt}\n`);
    expect(readFileSync(path.join(configDirectory, "oh-my-opencode-slim", "sherpa-agent-sources.md"), "utf8"))
      .toContain("MIT License");

    const before = [
      updatedText,
      readFileSync(path.join(configDirectory, "oh-my-opencode-slim", `${specialist.id}.md`), "utf8"),
      readFileSync(path.join(configDirectory, "oh-my-opencode-slim", ".sherpa-agent-ownership.json"), "utf8"),
    ];
    expect(syncSherpaOmoAgents([specialist], { configDirectory, sources }).unchanged).toEqual([specialist.id]);
    expect([
      readFileSync(configPath, "utf8"),
      readFileSync(path.join(configDirectory, "oh-my-opencode-slim", `${specialist.id}.md`), "utf8"),
      readFileSync(path.join(configDirectory, "oh-my-opencode-slim", ".sherpa-agent-ownership.json"), "utf8"),
    ]).toEqual(before);
  } finally {
    root.dispose();
  }
});

test("preserves conflicting user agent files and chooses existing JSON config", () => {
  const root = fixture();
  try {
    const configDirectory = path.join(root.root, "config");
    mkdirSync(configDirectory, { recursive: true });
    const configPath = root.write("config/oh-my-opencode-slim.json", '{"agents":{"sherpa-fixture-reviewer":{"description":"User"}}}\n');
    const prompts = path.join(configDirectory, "oh-my-opencode-slim");
    mkdirSync(prompts, { recursive: true });
    const promptPath = root.write("config/oh-my-opencode-slim/sherpa-fixture-reviewer.md", "User prompt.\n");
    const result = syncSherpaOmoAgents([agent("sherpa-fixture-reviewer")], { configDirectory });
    expect(result.collisions).toEqual([{ id: "sherpa-fixture-reviewer", reason: "unowned-artifact" }]);
    expect(config(configPath).agents["sherpa-fixture-reviewer"].description).toBe("User");
    expect(readFileSync(promptPath, "utf8")).toBe("User prompt.\n");
    expect(config(configPath).presets.session["sherpa-fixture-reviewer"]).toBeUndefined();
    expect(JSON.parse(readFileSync(path.join(prompts, ".sherpa-agent-ownership.json"), "utf8")))
      .toEqual({ version: 2, agents: {} });
  } finally {
    root.dispose();
  }
});

test("does not claim an agent ID already mapped by the codex preset", () => {
  const root = fixture();
  try {
    const configDirectory = path.join(root.root, "config");
    const configPath = root.write("config/oh-my-opencode-slim.jsonc", JSON.stringify({
      presets: { codex: { "sherpa-fixture-reviewer": { model: "user/reviewer" } } },
    }, null, 2) + "\n");

    const result = syncSherpaOmoAgents([agent("sherpa-fixture-reviewer")], { configDirectory });

    expect(result.collisions).toEqual([{ id: "sherpa-fixture-reviewer", reason: "unowned-artifact" }]);
    expect(config(configPath).presets.codex["sherpa-fixture-reviewer"])
      .toEqual({ model: "user/reviewer" });
    expect(config(configPath).presets.session["sherpa-fixture-reviewer"]).toBeUndefined();
    expect(config(configPath).agents["sherpa-fixture-reviewer"]).toBeUndefined();
  } finally {
    root.dispose();
  }
});

test("refuses ambiguous OMO config files without changing either", () => {
  const root = fixture();
  try {
    const configDirectory = path.join(root.root, "config");
    const jsonc = root.write("config/oh-my-opencode-slim.jsonc", "{}\n");
    const json = root.write("config/oh-my-opencode-slim.json", "{}\n");
    expect(() => syncSherpaOmoAgents([agent("sherpa-fixture-reviewer")], { configDirectory }))
      .toThrow("Multiple OMO-Slim config files exist");
    expect(readFileSync(jsonc, "utf8")).toBe("{}\n");
    expect(readFileSync(json, "utf8")).toBe("{}\n");
  } finally {
    root.dispose();
  }
});

test("updates a symlinked OMO config target without replacing the link", () => {
  const root = fixture();
  try {
    const configDirectory = path.join(root.root, "config");
    const externalConfig = root.write("linked-config/oh-my-opencode-slim.jsonc", [
      "{",
      "  // Keep the linked config comment.",
      '  "agents": {},',
      '  "presets": { "codex": {} }',
      "}",
      "",
    ].join("\n"));
    mkdirSync(configDirectory, { recursive: true });
    const configLink = path.join(configDirectory, "oh-my-opencode-slim.jsonc");
    symlinkSync(externalConfig, configLink);

    const specialist = agent("sherpa-fixture-linked-reviewer");
    const result = syncSherpaOmoAgents([specialist], { configDirectory });

    expect(result.installed).toEqual([specialist.id]);
    expect(lstatSync(configLink).isSymbolicLink()).toBe(true);
    expect(readFileSync(configLink, "utf8")).toContain("Keep the linked config comment.");
    expect(config(externalConfig).agents[specialist.id].description).toBe(specialist.description);
    expect(readFileSync(path.join(configDirectory, "oh-my-opencode-slim", `${specialist.id}.md`), "utf8"))
      .toBe(`${specialist.prompt}\n`);
  } finally {
    root.dispose();
  }
});
