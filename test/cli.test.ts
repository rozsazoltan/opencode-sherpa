import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import type { SherpaOmoAgent } from "../src/agent-sources.ts";
import { parseCliArgs, runCli } from "../src/cli.ts";
import { syncProject } from "../src/sync.ts";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "sherpa-cli-test-"));
  const write = (directory: string, relative: string, contents: string) => {
    const target = path.join(directory, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
    return target;
  };
  return { root, write, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

type FixtureWrite = (directory: string, relative: string, contents: string) => string;

function createTuning(root: string): void {
  const write = (relative: string, contents: string) => {
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  };
  write("tuning/instructions/00-core.md", "Prefer focused changes.\n");
  write("tuning/skills/review/SKILL.md", "---\ndescription: Review changes.\n---\nCheck correctness.\n");
  write("tuning/skills/review/references/checklist.md", "Check tests.\n");
  write("tuning/commands/review.md", "Review $ARGUMENTS.\n");
}

function createSelectionTuning(root: string): void {
  const write = (relative: string, contents: string) => {
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  };
  write("tuning/instructions/00-core.md", "Prefer focused changes.\n");
  for (const id of [
    "sherpa-php-development",
    "sherpa-js-development",
    "sherpa-rust-development",
    "sherpa-laravel-development",
    "sherpa-vue-development",
    "extra/optional-skill",
  ]) {
    write(`tuning/skills/${id}/SKILL.md`, `---\nname: ${id}\ndescription: Guidance for ${id}.\n---\n\n${id} guidance.\n`);
    write(`tuning/skills/${id}/references/checklist.md`, `Checklist for ${id}.\n`);
  }
  write("tuning/skills/review/SKILL.md", "---\ndescription: Review changes.\n---\nCheck correctness.\n");
  write("tuning/commands/review.md", "Review $ARGUMENTS.\n");
}

function projectAgents(): SherpaOmoAgent[] {
  const source = (id: string, sourcePath: string): SherpaOmoAgent => ({
    id,
    description: `Description for ${id}.`,
    orchestratorPrompt: `Delegate suitable work to @${id}.`,
    prompt: `# ${id}\n\nDo focused work.`,
    sourceNamespace: "fixture",
    sourceRepository: "example/agents",
    sourceCommit: "0".repeat(40),
    sourcePath,
  });
  return [
    source("sherpa-fixture-php-pro", "categories/php-pro.md"),
    source("sherpa-fixture-laravel-specialist", "categories/laravel-specialist.md"),
    source("sherpa-fixture-javascript-pro", "categories/javascript-pro.md"),
    source("sherpa-fixture-typescript-pro", "categories/typescript-pro.md"),
    source("sherpa-fixture-vue-expert", "categories/vue-expert.md"),
    source("sherpa-fixture-react-specialist", "categories/react-specialist.md"),
    source("sherpa-fixture-rust-engineer", "categories/rust-engineer.md"),
    source("sherpa-fixture-extra", "categories/extra.md"),
  ];
}

function snapshotFiles(directory: string): Map<string, string> {
  const files = new Map<string, string>();
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) files.set(path.relative(directory, target).split(path.sep).join("/"), readFileSync(target, "utf8"));
    }
  };
  visit(directory);
  return files;
}

function createMixedProject(write: FixtureWrite, project: string): void {
  write(project, "package.json", JSON.stringify({
    workspaces: ["apps/*", "packages/*"],
    dependencies: { typescript: "^5.0.0", vue: "^3.0.0" },
  }));
  write(project, "apps/web/package.json", JSON.stringify({ dependencies: { react: "^18.0.0" } }));
  write(project, "apps/worker/package.json", JSON.stringify({ dependencies: { next: "^14.0.0" } }));
  write(project, "apps/api/composer.json", JSON.stringify({ require: { "laravel/framework": "^11.0" } }));
  write(project, "libs/php/composer.json", JSON.stringify({ "require-dev": { "phpunit/phpunit": "^11.0" } }));
  write(project, "Cargo.toml", '[workspace]\nmembers = ["crates/*"]\n');
  write(project, "crates/server/Cargo.toml", '[package]\nname = "server"\nversion = "0.1.0"\n[dependencies]\naxum = "0.7"\n');
  write(project, "crates/tool/Cargo.toml", '[package]\nname = "tool"\nversion = "0.1.0"\n[dependencies]\nserde = "1"\n');
}

test("parses sync flags and rejects invalid arguments", () => {
  expect(parseCliArgs(["sync", "--project", "work", "--dry-run"], "/tmp/root")).toEqual({
    projectDirectory: "/tmp/root/work",
    dryRun: true,
    help: false,
  });
  expect(parseCliArgs([], "/tmp/root")).toMatchObject({ help: true, dryRun: false });
  for (const args of [
    ["install"],
    ["sync", "--unknown"],
    ["sync", "--project"],
    ["sync", "--project", "one", "--project", "two"],
    ["sync", "--dry-run", "--dry-run"],
  ]) {
    expect(() => parseCliArgs(args)).toThrow();
  }
});

test("syncs project tuning, MCP, and OMO entries while preserving user data", async () => {
  const fixtureData = fixture();
  const project = path.join(fixtureData.root, "project");
  const packageRoot = path.join(fixtureData.root, "package");
  mkdirSync(project);
  createTuning(packageRoot);
  try {
    fixtureData.write(project, "opencode-sherpa.jsonc", '{"agentSources":[],"skills":{"include":["review"]}}\n');
    fixtureData.write(project, "AGENTS.md", "# Existing project guidance\n\nKeep this text.\n");
    const opencodeConfig = fixtureData.write(project, "opencode.jsonc", [
      "{",
      '  "$schema": "https://opencode.ai/config.json",',
      '  "mcp": { "servers": { "github": { "type": "local", "command": ["user-github"] }, "custom": { "enabled": true } } }',
      "}",
    ].join("\n"));
    const omoConfig = fixtureData.write(project, ".opencode/oh-my-opencode-slim.jsonc", [
      '{"agents":{"reviewer":{"model":"user/reviewer"},"sherpa-stale":{"description":"stale"}},',
      '"presets":{"session":{"sherpa-stale":{"inheritModelFrom":"session"}}}}',
    ].join("\n"));
    const globalSentinel = fixtureData.write(fixtureData.root, "global/opencode.json", '{"mcp":{"global":true}}\n');
    const output: string[] = [];
    const exitCode = await runCli(["sync", "--project", project], {
      cwd: fixtureData.root,
      stdout: (line) => output.push(line),
      stderr: (line) => output.push(`ERROR: ${line}`),
    }, { packageRoot });

    expect(exitCode).toBe(0);
    expect(output).toContain("Wrote AGENTS.md");
    expect(output).toContain("Wrote .opencode/skills/review/SKILL.md");
    expect(output).toContain("Wrote .opencode/commands/review.md");
    expect(output.some((line) => line.includes("opencode.jsonc"))).toBe(true);
    const agents = readFileSync(path.join(project, "AGENTS.md"), "utf8");
    expect(agents).toContain("# Existing project guidance");
    expect(agents).toContain("Keep this text.");
    expect(agents).toContain("Prefer focused changes.");
    expect(readFileSync(path.join(project, ".opencode/skills/review/SKILL.md"), "utf8"))
      .toContain("description: Review changes.");
    expect(readFileSync(path.join(project, ".opencode/skills/review/references/checklist.md"), "utf8"))
      .toBe("Check tests.\n");
    expect(readFileSync(path.join(project, ".opencode/commands/review.md"), "utf8"))
      .toBe("Review $ARGUMENTS.\n");
    expect(parseJsonc(readFileSync(opencodeConfig, "utf8"))).toMatchObject({
      "$schema": "https://opencode.ai/config.json",
      mcp: {
        servers: {
          github: { type: "local", command: ["user-github"] },
          custom: { enabled: true },
          jina: { type: "remote", url: "https://mcp.jina.ai/v1" },
          context7: { type: "remote", url: "https://mcp.context7.com/mcp" },
          gh_grep: { type: "remote", url: "https://mcp.grep.app" },
        },
      },
    });
    expect(parseJsonc(readFileSync(omoConfig, "utf8"))).toEqual({
      agents: { reviewer: { model: "user/reviewer" } },
      presets: { session: {} },
    });
    expect(readFileSync(globalSentinel, "utf8")).toBe('{"mcp":{"global":true}}\n');

    const before = readFileSync(path.join(project, "AGENTS.md"), "utf8");
    const second = await syncProject({ projectDirectory: project, packageRoot });
    expect(second.messages).toContain("Project is up to date.");
    expect(readFileSync(path.join(project, "AGENTS.md"), "utf8")).toBe(before);
  } finally {
    fixtureData.dispose();
  }
});

test("dry-run reports planned writes without changing project files", async () => {
  const fixtureData = fixture();
  const project = path.join(fixtureData.root, "project");
  const packageRoot = path.join(fixtureData.root, "package");
  mkdirSync(project);
  createTuning(packageRoot);
  fixtureData.write(project, "opencode-sherpa.json", '{"agentSources":[],"skills":{"include":["review"]}}\n');
  try {
    const output: string[] = [];
    const exitCode = await runCli(["sync", "--project", project, "--dry-run"], {
      cwd: fixtureData.root,
      stdout: (line) => output.push(line),
      stderr: (line) => output.push(`ERROR: ${line}`),
    }, { packageRoot });
    expect(exitCode).toBe(0);
    expect(output).toContain("Would write AGENTS.md");
    expect(output.some((line) => line.startsWith("Would write .opencode/"))).toBe(true);
    expect(() => readFileSync(path.join(project, "AGENTS.md"))).toThrow();
    expect(() => readFileSync(path.join(project, "opencode.json"))).toThrow();
    expect(() => readFileSync(path.join(project, ".opencode"))).toThrow();
  } finally {
    fixtureData.dispose();
  }
});

test("sync detects mixed repository stacks, selects curated content, and removes deselected owned content", async () => {
  const fixtureData = fixture();
  const project = path.join(fixtureData.root, "project");
  const packageRoot = path.join(fixtureData.root, "package");
  mkdirSync(project);
  createMixedProject(fixtureData.write, project);
  createSelectionTuning(packageRoot);
  fixtureData.write(project, "opencode-sherpa.json", '{"agentSources":[]}\n');
  fixtureData.write(project, "opencode.jsonc", '{"mcp":{"servers":{"user-server":{"enabled":true}}}}\n');
  fixtureData.write(project, ".opencode/oh-my-opencode-slim.jsonc", '{"agents":{"reviewer":{"model":"user/reviewer"}}}\n');
  fixtureData.write(project, ".opencode/oh-my-opencode-slim/user-prompt.md", "User prompt.\n");
  const agents = projectAgents();
  const resolveSources = async (sources: readonly unknown[]) => {
    expect(sources).toEqual([]);
    return { agents, sources: [], diagnostics: [] };
  };

  try {
    const beforeDryRun = snapshotFiles(project);
    const dryRun = await syncProject({ projectDirectory: project, packageRoot, dryRun: true }, { resolveSources });
    expect(snapshotFiles(project)).toEqual(beforeDryRun);
    expect(dryRun.messages).toContain("Detected stacks: js, php, rust");
    expect(dryRun.messages).toContain("Detected features: axum, laravel, next, phpunit, react, serde, typescript, vue");
    for (const manifest of [
      "package.json",
      "apps/api/composer.json",
      "apps/web/package.json",
      "apps/worker/package.json",
      "libs/php/composer.json",
      "Cargo.toml",
      "crates/server/Cargo.toml",
      "crates/tool/Cargo.toml",
    ]) {
      expect(dryRun.messages.some((message) => message.startsWith(`Manifest evidence ${manifest}:`))).toBe(true);
    }
    expect(dryRun.messages).toContain("- sherpa-fixture-laravel-specialist: Matched detected laravel feature.");
    expect(dryRun.messages).toContain("- sherpa-laravel-development: Matched detected laravel feature.");
    expect(dryRun.messages).toContain("Would write .opencode/skills/sherpa-js-development/SKILL.md");
    expect(dryRun.messages).not.toContain("Would write .opencode/skills/extra/optional-skill/SKILL.md");
    expect(dryRun.messages).not.toContain("Would write .opencode/skills/review/SKILL.md");

    const first = await syncProject({ projectDirectory: project, packageRoot }, { resolveSources });
    const summary = (messages: readonly string[]) => messages.filter((message) =>
      message.startsWith("Detected ") || message.startsWith("Manifest evidence ") ||
      message.startsWith("Selected ") || message.startsWith("- "));
    expect(summary(first.messages)).toEqual(summary(dryRun.messages));
    const normalizeDryRun = (message: string) => message
      .replace(/^Would write /u, "Wrote ")
      .replace(/^Would remove /u, "Removed ")
      .replace(/^Would update /u, "Updated ");
    expect(dryRun.messages.map(normalizeDryRun)).toEqual([...first.messages]);
    for (const skill of [
      "sherpa-php-development",
      "sherpa-js-development",
      "sherpa-rust-development",
      "sherpa-laravel-development",
      "sherpa-vue-development",
    ]) {
      expect(readFileSync(path.join(project, `.opencode/skills/${skill}/SKILL.md`), "utf8")).toContain(`${skill} guidance.`);
    }
    for (const skill of ["extra/optional-skill", "review"]) {
      expect(() => readFileSync(path.join(project, `.opencode/skills/${skill}/SKILL.md`))).toThrow();
    }
    expect(readFileSync(path.join(project, ".opencode/commands/review.md"), "utf8")).toBe("Review $ARGUMENTS.\n");
    const omo = parseJsonc(readFileSync(path.join(project, ".opencode/oh-my-opencode-slim.jsonc"), "utf8")) as {
      agents: Record<string, unknown>;
    };
    expect(Object.keys(omo.agents).sort()).toEqual([
      "reviewer",
      "sherpa-fixture-javascript-pro",
      "sherpa-fixture-laravel-specialist",
      "sherpa-fixture-php-pro",
      "sherpa-fixture-react-specialist",
      "sherpa-fixture-rust-engineer",
      "sherpa-fixture-typescript-pro",
      "sherpa-fixture-vue-expert",
    ]);
    expect(readFileSync(path.join(project, ".opencode/oh-my-opencode-slim/user-prompt.md"), "utf8")).toBe("User prompt.\n");

    const editedSkill = path.join(project, ".opencode/skills/sherpa-js-development/SKILL.md");
    writeFileSync(editedSkill, "User-edited JavaScript guidance.\n");
    fixtureData.write(project, ".opencode/skills/user-owned/SKILL.md", "User-owned skill.\n");
    fixtureData.write(project, "opencode-sherpa.json", JSON.stringify({
      agentSources: [],
      agents: { auto: false, include: ["sherpa-fixture-php-pro"] },
      skills: { auto: false, include: ["sherpa-php-development"] },
    }));

    const reduced = await syncProject({ projectDirectory: project, packageRoot }, { resolveSources });
    expect(reduced.messages).toContain("Preserved user file .opencode/skills/sherpa-js-development/SKILL.md");
    expect(reduced.messages).toContain("Removed .opencode/skills/sherpa-rust-development/SKILL.md");
    expect(readFileSync(editedSkill, "utf8")).toBe("User-edited JavaScript guidance.\n");
    expect(readFileSync(path.join(project, ".opencode/skills/user-owned/SKILL.md"), "utf8")).toBe("User-owned skill.\n");
    expect(() => readFileSync(path.join(project, ".opencode/skills/sherpa-js-development/references/checklist.md"))).toThrow();
    expect(() => readFileSync(path.join(project, ".opencode/skills/sherpa-rust-development/SKILL.md"))).toThrow();
    expect(readFileSync(path.join(project, ".opencode/skills/sherpa-php-development/SKILL.md"), "utf8"))
      .toContain("sherpa-php-development guidance.");
    const reducedOmo = parseJsonc(readFileSync(path.join(project, ".opencode/oh-my-opencode-slim.jsonc"), "utf8")) as {
      agents: Record<string, unknown>;
    };
    expect(Object.keys(reducedOmo.agents).sort()).toEqual(["reviewer", "sherpa-fixture-php-pro"]);
    expect(() => readFileSync(path.join(project, ".opencode/oh-my-opencode-slim/sherpa-fixture-rust-engineer.md"))).toThrow();
    expect(readFileSync(path.join(project, ".opencode/oh-my-opencode-slim/user-prompt.md"), "utf8")).toBe("User prompt.\n");
    expect(parseJsonc(readFileSync(path.join(project, "opencode.jsonc"), "utf8"))).toMatchObject({
      mcp: { servers: { "user-server": { enabled: true } } },
    });
  } finally {
    fixtureData.dispose();
  }
});

test("empty and disabled detection select only explicit content", async () => {
  const fixtureData = fixture();
  const emptyProject = path.join(fixtureData.root, "empty-project");
  const disabledProject = path.join(fixtureData.root, "disabled-project");
  const packageRoot = path.join(fixtureData.root, "package");
  mkdirSync(emptyProject);
  mkdirSync(disabledProject);
  createSelectionTuning(packageRoot);
  fixtureData.write(emptyProject, "opencode-sherpa.json", '{"agentSources":[]}\n');
  fixtureData.write(disabledProject, "package.json", '{"dependencies":{"typescript":"^5"}}\n');
  fixtureData.write(disabledProject, "opencode-sherpa.json", JSON.stringify({
    agentSources: [],
    detection: { enabled: false },
    agents: { auto: false, include: ["sherpa-fixture-extra"] },
    skills: { auto: false, include: ["extra/optional-skill"] },
  }));
  const agents = projectAgents();

  try {
    const empty = await syncProject({ projectDirectory: emptyProject, packageRoot });
    expect(empty.messages).toContain("Detected stacks: none");
    expect(empty.messages).toContain("Manifest evidence: none");
    expect(empty.messages).toContain("Selected agents: none");
    expect(empty.messages).toContain("Selected skills: none");
    expect(() => readFileSync(path.join(emptyProject, ".opencode/oh-my-opencode-slim.json"))).toThrow();
    expect(() => readFileSync(path.join(emptyProject, ".opencode/skills/sherpa-php-development/SKILL.md"))).toThrow();

    const manual = await syncProject({ projectDirectory: disabledProject, packageRoot }, {
      resolveSources: async () => ({ agents, sources: [], diagnostics: [] }),
    });
    expect(manual.messages).toContain("Detected stacks: none");
    expect(manual.messages).toContain("- sherpa-fixture-extra: Explicitly included.");
    expect(manual.messages).toContain("- extra/optional-skill: Explicitly included.");
    expect(readFileSync(path.join(disabledProject, ".opencode/oh-my-opencode-slim/sherpa-fixture-extra.md"), "utf8"))
      .toContain("Do focused work.");
    expect(readFileSync(path.join(disabledProject, ".opencode/skills/extra/optional-skill/SKILL.md"), "utf8"))
      .toContain("extra/optional-skill guidance.");
    expect(() => readFileSync(path.join(disabledProject, ".opencode/skills/sherpa-js-development/SKILL.md"))).toThrow();
  } finally {
    fixtureData.dispose();
  }
});

test("invalid preferences, manifests, and content IDs fail before project writes", async () => {
  type InvalidCase = {
    readonly name: string;
    readonly settings: string;
    readonly setup: (write: FixtureWrite, project: string) => void;
    readonly resolves: boolean;
  };
  const cases: InvalidCase[] = [
    { name: "invalid detection options", settings: '{"agentSources":[],"detection":{"enabled":"no"}}', setup: () => undefined, resolves: false },
    { name: "malformed project manifest", settings: '{"agentSources":[]}', setup: (write, project) => { write(project, "package.json", "{bad json"); }, resolves: false },
    { name: "unknown agent ID", settings: JSON.stringify({ agentSources: [], agents: { include: ["sherpa-missing"] } }), setup: () => undefined, resolves: true },
    { name: "unknown agent exclude ID", settings: JSON.stringify({ agentSources: [], agents: { exclude: ["sherpa-missing"] } }), setup: () => undefined, resolves: true },
    { name: "unknown skill ID", settings: JSON.stringify({ agentSources: [], skills: { include: ["sherpa-missing"] } }), setup: () => undefined, resolves: true },
    { name: "malformed ownership manifest", settings: '{"agentSources":[]}', setup: (write, project) => { write(project, ".opencode/.sherpa-files.json", "{}\n"); }, resolves: true },
  ];

  for (const item of cases) {
    const fixtureData = fixture();
    const project = path.join(fixtureData.root, "project");
    const packageRoot = path.join(fixtureData.root, "package");
    mkdirSync(project);
    createSelectionTuning(packageRoot);
    fixtureData.write(project, "opencode-sherpa.json", item.settings);
    item.setup(fixtureData.write, project);
    let resolveCount = 0;
    const before = snapshotFiles(project);
    try {
      await expect(syncProject({ projectDirectory: project, packageRoot }, {
        resolveSources: async () => {
          resolveCount += 1;
          return { agents: projectAgents(), sources: [], diagnostics: [] };
        },
      })).rejects.toThrow();
      expect(resolveCount).toBe(item.resolves ? 1 : 0);
      expect(snapshotFiles(project)).toEqual(before);
      expect(() => readFileSync(path.join(project, "AGENTS.md"))).toThrow();
      expect(() => readFileSync(path.join(project, "opencode.json"))).toThrow();
    } finally {
      fixtureData.dispose();
    }
  }
});

test("null detection configuration fails before resolution for sync and dry-run", async () => {
  for (const dryRun of [false, true]) {
    const fixtureData = fixture();
    const project = path.join(fixtureData.root, "project");
    mkdirSync(project);
    fixtureData.write(project, "opencode-sherpa.json", '{"agentSources":[],"detection":null}\n');
    let resolveCount = 0;
    const before = snapshotFiles(project);

    try {
      await expect(syncProject({ projectDirectory: project, dryRun }, {
        resolveSources: async () => {
          resolveCount += 1;
          return { agents: [], sources: [], diagnostics: [] };
        },
      })).rejects.toThrow("Project detection options must be an object.");
      expect(resolveCount).toBe(0);
      expect(snapshotFiles(project)).toEqual(before);
    } finally {
      fixtureData.dispose();
    }
  }
});

test("source resolution failure exits clearly without changing project files", async () => {
  const fixtureData = fixture();
  const project = path.join(fixtureData.root, "project");
  mkdirSync(project);
  const settings = fixtureData.write(project, "opencode-sherpa.json", '{"agentSources":[],"skills":{"include":["review"]}}\n');
  try {
    const output: string[] = [];
    const exitCode = await runCli(["sync", "--project", project], {
      cwd: fixtureData.root,
      stdout: (line) => output.push(line),
      stderr: (line) => output.push(line),
    }, {
      resolveSources: async () => ({
        agents: [],
        sources: [],
        diagnostics: [{
          namespace: "fixture",
          repository: "example/agents",
          commit: "0".repeat(40),
          code: "source-unavailable",
          message: "Pinned archive unavailable.",
        }],
      }),
    });
    expect(exitCode).toBe(1);
    expect(output.join("\n")).toContain("Agent source resolution failed; project files were not changed.");
    expect(output.join("\n")).toContain("fixture (source-unavailable): Pinned archive unavailable.");
    expect(readFileSync(settings, "utf8")).toBe('{"agentSources":[],"skills":{"include":["review"]}}\n');
    expect(() => readFileSync(path.join(project, "AGENTS.md"))).toThrow();
    expect(() => readFileSync(path.join(project, "opencode.json"))).toThrow();
  } finally {
    fixtureData.dispose();
  }
});

test("preserves user-owned command and skill files", async () => {
  const fixtureData = fixture();
  const project = path.join(fixtureData.root, "project");
  const packageRoot = path.join(fixtureData.root, "package");
  mkdirSync(project);
  createTuning(packageRoot);
  fixtureData.write(project, "opencode-sherpa.json", '{"agentSources":[],"skills":{"include":["review"]}}\n');
  const userCommand = fixtureData.write(project, ".opencode/commands/review.md", "User command.\n");
  const userSkill = fixtureData.write(project, ".opencode/skills/review/SKILL.md", "User skill.\n");
  try {
    const result = await syncProject({ projectDirectory: project, packageRoot });
    expect(result.messages).toContain("Preserved user file .opencode/commands/review.md");
    expect(result.messages).toContain("Preserved user file .opencode/skills/review/SKILL.md");
    expect(readFileSync(userCommand, "utf8")).toBe("User command.\n");
    expect(readFileSync(userSkill, "utf8")).toBe("User skill.\n");
    expect(() => readFileSync(path.join(project, ".opencode/skills/review/references/checklist.md"))).toThrow();
  } finally {
    fixtureData.dispose();
  }
});
