import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { hash } from "../src/agent-files.ts";
import type { SherpaOmoAgent } from "../src/agent-sources.ts";
import { parseCliArgs, runCli as runCliImpl } from "../src/cli.ts";
import { syncProject as syncProjectImpl, type SyncDependencies } from "../src/sync.ts";
import type { SherpaSkillResolution } from "../src/skill-sources.ts";

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

function syncProject(
  options: Parameters<typeof syncProjectImpl>[0],
  dependencies: SyncDependencies = {},
) {
  return syncProjectImpl(options, {
    ...dependencies,
    globalConfigDirectory: dependencies.globalConfigDirectory ?? path.resolve(options.projectDirectory, ".test-global-opencode-config"),
  });
}

function runCli(
  args: Parameters<typeof runCliImpl>[0],
  io: Parameters<typeof runCliImpl>[1] = {},
  dependencies: SyncDependencies = {},
) {
  const projectOption = args.indexOf("--project");
  const requestedProject = projectOption < 0 ? undefined : args[projectOption + 1];
  const projectDirectory = path.resolve(io.cwd ?? process.cwd(), requestedProject && !requestedProject.startsWith("--")
    ? requestedProject
    : ".");
  return runCliImpl(args, io, {
    ...dependencies,
    globalConfigDirectory: dependencies.globalConfigDirectory ?? path.join(projectDirectory, ".test-global-opencode-config"),
  });
}

type FixtureWrite = (directory: string, relative: string, contents: string) => string;

const RAW_UPSTREAM_SKILL = Buffer.from("\uFEFF---\r\ndescription: Upstream fixture skill.\r\n---\r\n\r\nOriginal upstream bytes.\r\n", "utf8");
const UPSTREAM_BINARY = Buffer.from([0, 255, 7, 13, 10, 128]);
const UPSTREAM_LICENSE = Buffer.from("Fixture license bytes.\n", "utf8");
const UPSTREAM_SOURCE = Buffer.from('{"repository":"fixture"}\n', "utf8");

function fakeSkillResolver() {
  const calls: Array<{ ids: string[]; cacheDirectory?: string }> = [];
  const resolveSkillSources: NonNullable<SyncDependencies["resolveSkillSources"]> = async (sources, options = {}) => {
    const ids = [...(options.skillIds ?? [])];
    calls.push({ ids, ...(options.cacheDirectory ? { cacheDirectory: options.cacheDirectory } : {}) });
    const skills = ids.map((id) => {
      const source = sources.find((candidate) => candidate.skills.some((entry) => `sherpa-${candidate.namespace}-${entry.id}` === id));
      const entry = source?.skills.find((candidate) => `sherpa-${source.namespace}-${candidate.id}` === id);
      if (!source || !entry) throw new Error(`Fake resolver received undeclared skill ${id}`);
      const licenseEvidence = source.licensePath
        ? { kind: "file" as const, path: source.licensePath, sha256: hash(UPSTREAM_LICENSE) }
        : { kind: "declared" as const, identifier: source.license! };
      const files = new Map<string, Buffer>([
        ["SKILL.md", Buffer.from(RAW_UPSTREAM_SKILL)],
        ["references/guide.md", Buffer.from("Support file.\r\n")],
        ["references/sample.bin", Buffer.from(UPSTREAM_BINARY)],
        ["SHERPA-SOURCE.json", Buffer.from(UPSTREAM_SOURCE)],
      ]);
      if (source.licensePath) files.set("SHERPA-LICENSE.txt", Buffer.from(UPSTREAM_LICENSE));
      return {
        id,
        name: "Fixture upstream skill",
        description: "Upstream fixture skill.",
        path: `${source.repository}@${source.commit}/${entry.path}`,
        content: "Parsed content is not used for materialization.",
        files,
      };
    });
    const sourceInfos = sources.flatMap((source) => {
      const selected = skills.filter(({ id }) => id.startsWith(`sherpa-${source.namespace}-`));
      if (selected.length === 0) return [];
      return [{
        namespace: source.namespace,
        repository: source.repository,
        commit: source.commit,
        archiveSha256: "c".repeat(64),
        skills: selected.map(({ id }) => {
          const entry = source.skills.find((candidate) => `sherpa-${source.namespace}-${candidate.id}` === id)!;
          const licenseEvidence = source.licensePath
            ? { kind: "file" as const, path: source.licensePath, sha256: hash(UPSTREAM_LICENSE) }
            : { kind: "declared" as const, identifier: source.license! };
          return { id, sourcePath: entry.path, licenseEvidence };
        }),
      }];
    });
    return { skills, sources: sourceInfos, diagnostics: [] } satisfies SherpaSkillResolution;
  };
  return { calls, resolveSkillSources };
}

function defaultSkillSourceSettings(): { includeDefaults: true; sources: [] } {
  return { includeDefaults: true, sources: [] };
}

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
  write("tuning/instructions/00-sherpa-principles.md", "Common Sherpa guidance.\n");
  write("tuning/instructions/10-js-development.md", "JavaScript Sherpa guidance.\n");
  write("tuning/instructions/20-php-development.md", "PHP Sherpa guidance.\n");
  write("tuning/instructions/30-rust-development.md", "Rust Sherpa guidance.\n");
  write("tuning/skills/review/SKILL.md", "---\ndescription: Review changes.\n---\nCheck correctness.\n");
  write("tuning/commands/review.md", "Review $ARGUMENTS.\n");
  write("tuning/commands/sherpa-js-check.md", "Run JavaScript checks.\n");
  write("tuning/commands/sherpa-php-check.md", "Run PHP checks.\n");
  write("tuning/commands/sherpa-rust-check.md", "Run Rust checks.\n");
  write("tuning/commands/sherpa-write-issue.md", "Write an issue.\n");
  write("tuning/commands/sherpa-write-pr.md", "Write a pull request.\n");
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
    fixtureData.write(project, "opencode-sherpa.jsonc", '{"agentSources":[],"skillSources":[],"commands":{"include":["review"]},"instructions":{"include":["00-core"]},"skills":{"include":["review"]}}\n');
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
  fixtureData.write(project, "opencode-sherpa.json", '{"agentSources":[],"skillSources":[],"commands":{"include":["review"]},"instructions":{"include":["00-core"]},"skills":{"include":["review"]}}\n');
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
  fixtureData.write(project, "opencode-sherpa.json", JSON.stringify({
    agentSources: [],
    skillSources: [],
    commands: { include: ["review"] },
    skills: {
      auto: false,
      include: ["sherpa-php-development", "sherpa-js-development", "sherpa-rust-development", "sherpa-laravel-development", "sherpa-vue-development"],
    },
  }));
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
    expect(dryRun.messages).toContain("- sherpa-laravel-development: Explicitly included.");
    expect(dryRun.messages).toContain("- sherpa-js-check: Matched detected js stack.");
    expect(dryRun.messages).toContain("- sherpa-php-check: Matched detected php stack.");
    expect(dryRun.messages).toContain("- sherpa-rust-check: Matched detected rust stack.");
    expect(dryRun.messages).toContain("- 00-sherpa-principles: Common project guidance.");
    expect(dryRun.messages).toContain("- 10-js-development: Matched detected js stack.");
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
    for (const [name, body] of [
      ["sherpa-js-check", "Run JavaScript checks.\n"],
      ["sherpa-php-check", "Run PHP checks.\n"],
      ["sherpa-rust-check", "Run Rust checks.\n"],
    ] as const) {
      expect(readFileSync(path.join(project, `.opencode/commands/${name}.md`), "utf8")).toBe(body);
    }
    const selectedInstructions = readFileSync(path.join(project, "AGENTS.md"), "utf8");
    expect(selectedInstructions).toContain("JavaScript Sherpa guidance.");
    expect(selectedInstructions).toContain("PHP Sherpa guidance.");
    expect(selectedInstructions).toContain("Rust Sherpa guidance.");
    expect(() => readFileSync(path.join(project, ".opencode/commands/sherpa-write-issue.md"))).toThrow();
    expect(() => readFileSync(path.join(project, ".opencode/commands/sherpa-write-pr.md"))).toThrow();
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
      commands: { include: ["review"] },
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

test("selects stack-matched commands and instructions with common guidance", async () => {
  const fixtureData = fixture();
  const packageRoot = path.join(fixtureData.root, "package");
  createSelectionTuning(packageRoot);
  const cases = [
    {
      name: "js",
      manifest: (write: FixtureWrite, project: string) => write(project, "package.json", '{"dependencies":{"typescript":"^5"}}'),
      commands: ["sherpa-js-check"],
      instructions: ["10-js-development"],
    },
    {
      name: "php",
      manifest: (write: FixtureWrite, project: string) => write(project, "composer.json", '{"require":{"phpunit/phpunit":"^11"}}'),
      commands: ["sherpa-php-check"],
      instructions: ["20-php-development"],
    },
    {
      name: "rust",
      manifest: (write: FixtureWrite, project: string) => write(project, "Cargo.toml", '[package]\nname = "fixture"\nversion = "0.1.0"\n[dependencies]\nserde = "1"\n'),
      commands: ["sherpa-rust-check"],
      instructions: ["30-rust-development"],
    },
    {
      name: "mixed",
      manifest: createMixedProject,
      commands: ["sherpa-js-check", "sherpa-php-check", "sherpa-rust-check"],
      instructions: ["10-js-development", "20-php-development", "30-rust-development"],
    },
  ] as const;

  try {
    for (const item of cases) {
      const project = path.join(fixtureData.root, `project-${item.name}`);
      mkdirSync(project);
      item.manifest(fixtureData.write, project);
      fixtureData.write(project, "opencode-sherpa.json", '{"agentSources":[],"skillSources":[]}\n');
      const beforeDryRun = snapshotFiles(project);
      const dryRun = await syncProject({ projectDirectory: project, packageRoot, dryRun: true });
      expect(snapshotFiles(project)).toEqual(beforeDryRun);
      const result = await syncProject({ projectDirectory: project, packageRoot });
      const normalize = (message: string) => message
        .replace(/^Would write /u, "Wrote ")
        .replace(/^Would remove /u, "Removed ")
        .replace(/^Would update /u, "Updated ");
      expect(dryRun.messages.map(normalize)).toEqual([...result.messages]);
      expect(dryRun.messages).toContain("- 00-sherpa-principles: Common project guidance.");

      const selectedCommands = new Set<string>(item.commands);
      for (const name of ["sherpa-js-check", "sherpa-php-check", "sherpa-rust-check", "sherpa-write-issue", "sherpa-write-pr", "review"]) {
        const file = path.join(project, `.opencode/commands/${name}.md`);
        if (selectedCommands.has(name)) {
          expect(readFileSync(file, "utf8")).toBe(name === "sherpa-js-check"
            ? "Run JavaScript checks.\n"
            : name === "sherpa-php-check"
              ? "Run PHP checks.\n"
              : "Run Rust checks.\n");
        } else {
          expect(() => readFileSync(file)).toThrow();
        }
      }

      const instructionBlock = readFileSync(path.join(project, "AGENTS.md"), "utf8");
      expect(instructionBlock).toContain("Common Sherpa guidance.");
      const selectedInstructions = new Set<string>(item.instructions);
      for (const [id, body] of [
        ["10-js-development", "JavaScript Sherpa guidance."],
        ["20-php-development", "PHP Sherpa guidance."],
        ["30-rust-development", "Rust Sherpa guidance."],
      ] as const) {
        expect(instructionBlock.includes(body)).toBe(selectedInstructions.has(id));
      }
      for (const name of ["sherpa-js-check", "sherpa-php-check", "sherpa-rust-check"]) {
        expect(dryRun.messages.includes(`- ${name}: Matched detected ${name === "sherpa-js-check" ? "js" : name === "sherpa-php-check" ? "php" : "rust"} stack.`))
          .toBe(selectedCommands.has(name));
      }
    }
  } finally {
    fixtureData.dispose();
  }
});

test("auto false includes manual content and exclusions take priority", async () => {
  const fixtureData = fixture();
  const project = path.join(fixtureData.root, "project");
  const packageRoot = path.join(fixtureData.root, "package");
  mkdirSync(project);
  createSelectionTuning(packageRoot);
  fixtureData.write(project, "package.json", '{"dependencies":{"typescript":"^5"}}');
  fixtureData.write(project, "opencode-sherpa.json", JSON.stringify({
    agentSources: [],
    skillSources: [],
    commands: { auto: false, include: ["sherpa-js-check", "sherpa-write-issue"], exclude: ["sherpa-js-check"] },
    instructions: { auto: false, include: ["00-core", "10-js-development"], exclude: ["10-js-development"] },
  }));

  try {
    const result = await syncProject({ projectDirectory: project, packageRoot });
    expect(result.messages).toContain("- sherpa-write-issue: Explicitly included.");
    expect(result.messages).not.toContain("- sherpa-js-check: Matched detected js stack.");
    expect(result.messages).toContain("- 00-core: Explicitly included.");
    expect(result.messages).not.toContain("- 10-js-development: Explicitly included.");
    expect(readFileSync(path.join(project, ".opencode/commands/sherpa-write-issue.md"), "utf8")).toBe("Write an issue.\n");
    expect(() => readFileSync(path.join(project, ".opencode/commands/sherpa-js-check.md"))).toThrow();
    const content = readFileSync(path.join(project, "AGENTS.md"), "utf8");
    expect(content).toContain("Prefer focused changes.");
    expect(content).not.toContain("Common Sherpa guidance.");
    expect(content).not.toContain("JavaScript Sherpa guidance.");
  } finally {
    fixtureData.dispose();
  }
});

test("selection shrink cleans owned commands and instructions without touching user content", async () => {
  const fixtureData = fixture();
  const project = path.join(fixtureData.root, "project");
  const packageRoot = path.join(fixtureData.root, "package");
  mkdirSync(project);
  createMixedProject(fixtureData.write, project);
  createSelectionTuning(packageRoot);
  fixtureData.write(project, "opencode-sherpa.json", '{"agentSources":[],"skillSources":[],"language":"Hungarian"}\n');
  fixtureData.write(project, "AGENTS.md", "# User before\n\n# User after\n");

  try {
    await syncProject({ projectDirectory: project, packageRoot });
    const agentsFile = path.join(project, "AGENTS.md");
    const generated = readFileSync(agentsFile, "utf8");
    writeFileSync(agentsFile, `${generated.replace("# User after", "")}\n# User after\n`);
    const editedCommand = path.join(project, ".opencode/commands/sherpa-php-check.md");
    writeFileSync(editedCommand, "User-edited PHP command.\n");
    const customCommand = fixtureData.write(project, ".opencode/commands/custom.md", "User-owned custom command.\n");
    fixtureData.write(project, "opencode-sherpa.json", JSON.stringify({
      agentSources: [],
      skillSources: [],
      language: "Hungarian",
      commands: { auto: false, include: ["review"] },
      instructions: { auto: false },
      agents: { auto: false },
      skills: { auto: false },
    }));

    const reduced = await syncProject({ projectDirectory: project, packageRoot });
    expect(reduced.messages).toContain("Preserved user file .opencode/commands/sherpa-php-check.md");
    expect(reduced.messages).toContain("Removed .opencode/commands/sherpa-js-check.md");
    expect(reduced.messages).toContain("Removed .opencode/commands/sherpa-rust-check.md");
    expect(readFileSync(editedCommand, "utf8")).toBe("User-edited PHP command.\n");
    expect(readFileSync(customCommand, "utf8")).toBe("User-owned custom command.\n");
    expect(readFileSync(path.join(project, ".opencode/commands/review.md"), "utf8")).toBe("Review $ARGUMENTS.\n");
    const manifest = JSON.parse(readFileSync(path.join(project, ".opencode/.sherpa-files.json"), "utf8")) as {
      files: Record<string, string>;
    };
    for (const name of ["sherpa-js-check", "sherpa-php-check", "sherpa-rust-check"]) {
      expect(manifest.files[`.opencode/commands/${name}.md`]).toBeUndefined();
    }
    const agents = readFileSync(agentsFile, "utf8");
    expect(agents).toContain("# User before");
    expect(agents).toContain("# User after");
    expect(agents).toContain("Use Hungarian for conversation");
    expect(agents).toContain("Write new code identifiers");
    expect(agents).not.toContain("Common Sherpa guidance.");
    expect(agents).not.toContain("JavaScript Sherpa guidance.");
    expect(agents).not.toContain("PHP Sherpa guidance.");
    expect(agents).not.toContain("Rust Sherpa guidance.");

    const beforeSecondApply = snapshotFiles(project);
    const second = await syncProject({ projectDirectory: project, packageRoot });
    expect(second.messages).toContain("Project is up to date.");
    expect(snapshotFiles(project)).toEqual(beforeSecondApply);
  } finally {
    fixtureData.dispose();
  }
});

test("empty and disabled detection select only explicit content", async () => {
  const fixtureData = fixture();
  const emptyProject = path.join(fixtureData.root, "empty-project");
  const disabledAutoProject = path.join(fixtureData.root, "disabled-auto-project");
  const disabledProject = path.join(fixtureData.root, "disabled-project");
  const packageRoot = path.join(fixtureData.root, "package");
  mkdirSync(emptyProject);
  mkdirSync(disabledAutoProject);
  mkdirSync(disabledProject);
  createSelectionTuning(packageRoot);
  fixtureData.write(emptyProject, "opencode-sherpa.json", '{"agentSources":[],"skillSources":[]}\n');
  fixtureData.write(disabledAutoProject, "package.json", '{"dependencies":{"typescript":"^5"}}');
  fixtureData.write(disabledAutoProject, "opencode-sherpa.json", '{"agentSources":[],"skillSources":[],"detection":{"enabled":false}}');
  fixtureData.write(disabledProject, "package.json", '{"dependencies":{"typescript":"^5"}}\n');
  fixtureData.write(disabledProject, "opencode-sherpa.json", JSON.stringify({
    agentSources: [],
    skillSources: [],
    detection: { enabled: false },
    agents: { auto: false, include: ["sherpa-fixture-extra"] },
    commands: { include: ["review"] },
    instructions: { include: ["00-core"] },
    skills: { auto: false, include: ["extra/optional-skill"] },
  }));
  const agents = projectAgents();

  try {
    const empty = await syncProject({ projectDirectory: emptyProject, packageRoot });
    expect(empty.messages).toContain("Detected stacks: none");
    expect(empty.messages).toContain("Manifest evidence: none");
    expect(empty.messages).toContain("Selected agents: none");
    expect(empty.messages).toContain("Selected skills: none");
    expect(empty.messages).toContain("Selected commands: none");
    expect(empty.messages).toContain("- 00-sherpa-principles: Common project guidance.");
    expect(readFileSync(path.join(emptyProject, "AGENTS.md"), "utf8")).toContain("Common Sherpa guidance.");
    expect(readFileSync(path.join(emptyProject, "AGENTS.md"), "utf8")).not.toContain("JavaScript Sherpa guidance.");
    expect(() => readFileSync(path.join(emptyProject, ".opencode/commands/sherpa-write-issue.md"))).toThrow();
    expect(() => readFileSync(path.join(emptyProject, ".opencode/oh-my-opencode-slim.json"))).toThrow();
    expect(() => readFileSync(path.join(emptyProject, ".opencode/skills/sherpa-php-development/SKILL.md"))).toThrow();

    const disabledAuto = await syncProject({ projectDirectory: disabledAutoProject, packageRoot });
    expect(disabledAuto.messages).toContain("Detected stacks: none");
    expect(disabledAuto.messages).toContain("Selected commands: none");
    expect(disabledAuto.messages).toContain("- 00-sherpa-principles: Common project guidance.");
    const disabledAutoInstructions = readFileSync(path.join(disabledAutoProject, "AGENTS.md"), "utf8");
    expect(disabledAutoInstructions).toContain("Common Sherpa guidance.");
    expect(disabledAutoInstructions).not.toContain("JavaScript Sherpa guidance.");

    const manual = await syncProject({ projectDirectory: disabledProject, packageRoot }, {
      resolveSources: async () => ({ agents, sources: [], diagnostics: [] }),
    });
    expect(manual.messages).toContain("Detected stacks: none");
    expect(manual.messages).toContain("- sherpa-fixture-extra: Explicitly included.");
    expect(manual.messages).toContain("- extra/optional-skill: Explicitly included.");
    expect(manual.messages).toContain("- review: Explicitly included.");
    expect(manual.messages).toContain("- 00-core: Explicitly included.");
    expect(manual.messages).toContain("- 00-sherpa-principles: Common project guidance.");
    expect(readFileSync(path.join(disabledProject, ".opencode/oh-my-opencode-slim/sherpa-fixture-extra.md"), "utf8"))
      .toContain("Do focused work.");
    expect(readFileSync(path.join(disabledProject, ".opencode/skills/extra/optional-skill/SKILL.md"), "utf8"))
      .toContain("extra/optional-skill guidance.");
    expect(readFileSync(path.join(disabledProject, ".opencode/commands/review.md"), "utf8")).toBe("Review $ARGUMENTS.\n");
    expect(readFileSync(path.join(disabledProject, "AGENTS.md"), "utf8")).toContain("Prefer focused changes.");
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
    { name: "invalid detection options", settings: '{"agentSources":[],"skillSources":[],"detection":{"enabled":"no"}}', setup: () => undefined, resolves: false },
    { name: "null command selection", settings: JSON.stringify({ agentSources: [], skillSources: [], commands: null }), setup: () => undefined, resolves: false },
    { name: "null instruction selection", settings: JSON.stringify({ agentSources: [], skillSources: [], instructions: null }), setup: () => undefined, resolves: false },
    { name: "unknown top-level command setting", settings: '{"agentSources":[],"skillSources":[],"commandss":{}}', setup: () => undefined, resolves: false },
    { name: "unsupported command selection field", settings: JSON.stringify({ agentSources: [], skillSources: [], commands: { optional: true } }), setup: () => undefined, resolves: false },
    { name: "unsupported instruction selection field", settings: JSON.stringify({ agentSources: [], skillSources: [], instructions: { optional: true } }), setup: () => undefined, resolves: false },
    { name: "malformed project manifest", settings: '{"agentSources":[],"skillSources":[]}', setup: (write, project) => { write(project, "package.json", "{bad json"); }, resolves: false },
    { name: "unknown agent ID", settings: JSON.stringify({ agentSources: [], skillSources: [], agents: { include: ["sherpa-missing"] } }), setup: () => undefined, resolves: true },
    { name: "unknown agent exclude ID", settings: JSON.stringify({ agentSources: [], skillSources: [], agents: { exclude: ["sherpa-missing"] } }), setup: () => undefined, resolves: true },
    { name: "unknown skill ID", settings: JSON.stringify({ agentSources: [], skillSources: [], skills: { include: ["sherpa-missing"] } }), setup: () => undefined, resolves: false },
    { name: "unknown command ID", settings: JSON.stringify({ agentSources: [], skillSources: [], commands: { include: ["sherpa-missing"] } }), setup: () => undefined, resolves: true },
    { name: "unknown instruction ID", settings: JSON.stringify({ agentSources: [], skillSources: [], instructions: { exclude: ["sherpa-missing"] } }), setup: () => undefined, resolves: true },
    { name: "malformed ownership manifest", settings: '{"agentSources":[],"skillSources":[]}', setup: (write, project) => { write(project, ".opencode/.sherpa-files.json", "{}\n"); }, resolves: true },
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

test("null detection and content selection fail before resolution for sync and dry-run", async () => {
  for (const setting of ["detection", "commands", "instructions"]) {
    for (const dryRun of [false, true]) {
      const fixtureData = fixture();
      const project = path.join(fixtureData.root, "project");
      mkdirSync(project);
      fixtureData.write(project, "opencode-sherpa.json", JSON.stringify({ agentSources: [], skillSources: [], [setting]: null }));
      let resolveCount = 0;
      const before = snapshotFiles(project);

      try {
        const result = syncProject({ projectDirectory: project, dryRun }, {
          resolveSources: async () => {
            resolveCount += 1;
            return { agents: [], sources: [], diagnostics: [] };
          },
        });
        await expect(result).rejects.toThrow(setting === "detection"
          ? "Project detection options must be an object."
          : "Content selection must be an object.");
        expect(resolveCount).toBe(0);
        expect(snapshotFiles(project)).toEqual(before);
      } finally {
        fixtureData.dispose();
      }
    }
  }
});

test("source resolution failure exits clearly without changing project files", async () => {
  const fixtureData = fixture();
  const project = path.join(fixtureData.root, "project");
  mkdirSync(project);
  const settings = fixtureData.write(project, "opencode-sherpa.json", '{"agentSources":[],"skillSources":[]}\n');
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
    expect(readFileSync(settings, "utf8")).toBe('{"agentSources":[],"skillSources":[]}\n');
    expect(() => readFileSync(path.join(project, "AGENTS.md"))).toThrow();
    expect(() => readFileSync(path.join(project, "opencode.json"))).toThrow();
  } finally {
    fixtureData.dispose();
  }
});

test("auto-selects pinned skills from PHP, JavaScript, and Rust evidence, not bundled skills", async () => {
  const fixtureData = fixture();
  const packageRoot = path.join(fixtureData.root, "package");
  createSelectionTuning(packageRoot);
  const expectedMixed = [
    "sherpa-antfu-pnpm",
    "sherpa-antfu-vite",
    "sherpa-antfu-vue",
    "sherpa-asyraf-php-best-practices",
    "sherpa-leonardomso-rust-skills",
    "sherpa-nuno-fortify-development",
    "sherpa-nuno-laravel-best-practices",
    "sherpa-nuno-wayfinder-development",
  ];
  const mixedProject = path.join(fixtureData.root, "mixed");
  mkdirSync(mixedProject);
  createMixedProject(fixtureData.write, mixedProject);
  fixtureData.write(mixedProject, "package.json", JSON.stringify({
    packageManager: "pnpm@9.0.0",
    workspaces: ["apps/*", "packages/*"],
    dependencies: { typescript: "^5.0.0", vue: "^3.0.0", vite: "^5.0.0" },
  }));
  fixtureData.write(mixedProject, "apps/api/composer.json", JSON.stringify({
    require: { "laravel/framework": "^11.0", "laravel/fortify": "^1.0", "laravel/wayfinder": "^0.1" },
  }));
  fixtureData.write(mixedProject, "opencode-sherpa.json", JSON.stringify({
    agentSources: [],
    skillSources: defaultSkillSourceSettings(),
  }));

  const frontendProject = path.join(fixtureData.root, "frontend");
  mkdirSync(frontendProject);
  fixtureData.write(frontendProject, "package.json", JSON.stringify({
    packageManager: "pnpm@9.0.0",
    dependencies: { vue: "^3.0.0", vite: "^5.0.0" },
  }));
  fixtureData.write(frontendProject, "opencode-sherpa.json", JSON.stringify({
    agentSources: [],
    skillSources: defaultSkillSourceSettings(),
  }));

  try {
    const mixedFake = fakeSkillResolver();
    const mixed = await syncProject({ projectDirectory: mixedProject, packageRoot }, {
      resolveSources: async () => ({ agents: [], sources: [], diagnostics: [] }),
      resolveSkillSources: mixedFake.resolveSkillSources,
    });
    expect(mixedFake.calls.map(({ ids }) => ids[0])).toHaveLength(1);
    expect(mixedFake.calls[0]?.ids).toEqual(expectedMixed);
    expect(mixed.messages).toContain("Detected stacks: js, php, rust");
    expect(mixed.messages).toContain("Detected features: axum, fortify, laravel, next, phpunit, pnpm, react, serde, typescript, vite, vue, wayfinder");
    expect(mixed.messages).toContain("- sherpa-nuno-fortify-development: Matched detected fortify feature.");
    expect(mixed.messages).toContain("- sherpa-nuno-wayfinder-development: Matched detected wayfinder feature.");
    expect(mixed.messages).not.toContain("- sherpa-php-development: Matched detected php stack.");
    expect(() => readFileSync(path.join(mixedProject, ".opencode/skills/sherpa-php-development/SKILL.md"))).toThrow();
    for (const id of expectedMixed) {
      expect(readFileSync(path.join(mixedProject, `.opencode/skills/${id}/SKILL.md`))).toEqual(RAW_UPSTREAM_SKILL);
    }

    const frontendFake = fakeSkillResolver();
    const frontend = await syncProject({ projectDirectory: frontendProject, packageRoot }, {
      resolveSources: async () => ({ agents: [], sources: [], diagnostics: [] }),
      resolveSkillSources: frontendFake.resolveSkillSources,
    });
    expect(frontendFake.calls[0]?.ids).toEqual(["sherpa-antfu-pnpm", "sherpa-antfu-vite", "sherpa-antfu-vue"]);
    expect(frontend.messages).not.toContain("- sherpa-nuno-fortify-development: Matched detected fortify feature.");
    expect(frontend.messages).not.toContain("- sherpa-nuno-wayfinder-development: Matched detected wayfinder feature.");
  } finally {
    fixtureData.dispose();
  }
});

test("explicit upstream and bundled skills materialize from byte maps and dry-run uses one temporary cache", async () => {
  const fixtureData = fixture();
  const project = path.join(fixtureData.root, "project");
  const packageRoot = path.join(fixtureData.root, "package");
  mkdirSync(project);
  createSelectionTuning(packageRoot);
  const externalIds = [
    "sherpa-antfu-antfu",
    "sherpa-mattpocock-diagnosing-bugs",
    "sherpa-superpowers-brainstorming",
  ];
  fixtureData.write(project, "opencode-sherpa.json", JSON.stringify({
    agentSources: [],
    skillSources: defaultSkillSourceSettings(),
    skills: { auto: false, include: [...externalIds, "extra/optional-skill"] },
  }));
  const baseResolver = fakeSkillResolver();
  const skillCacheDirectories: string[] = [];
  const agentCacheDirectories: string[] = [];
  const resolveSkillSources: NonNullable<SyncDependencies["resolveSkillSources"]> = async (sources, options = {}) => {
    if (options.cacheDirectory) {
      skillCacheDirectories.push(options.cacheDirectory);
      writeFileSync(path.join(options.cacheDirectory, "skill-cache-marker"), "cached\n");
    }
    return baseResolver.resolveSkillSources(sources, options);
  };
  const resolveSources: NonNullable<SyncDependencies["resolveSources"]> = async (_sources, options) => {
    if (options?.cacheDirectory) {
      agentCacheDirectories.push(options.cacheDirectory);
      writeFileSync(path.join(options.cacheDirectory, "agent-cache-marker"), "cached\n");
    }
    return { agents: [], sources: [], diagnostics: [] };
  };

  try {
    const beforeDryRun = snapshotFiles(project);
    const dryRun = await syncProject({ projectDirectory: project, packageRoot, dryRun: true }, {
      resolveSources,
      resolveSkillSources,
    });
    expect(snapshotFiles(project)).toEqual(beforeDryRun);
    expect(skillCacheDirectories).toHaveLength(1);
    expect(agentCacheDirectories).toEqual(skillCacheDirectories);
    expect(existsSync(skillCacheDirectories[0]!)).toBe(false);
    expect(baseResolver.calls[0]?.ids).toEqual(externalIds);
    expect(dryRun.messages).toContain("Would write .opencode/skills/sherpa-superpowers-brainstorming/references/sample.bin");
    expect(dryRun.messages.some((message) => message.startsWith("Skill source sherpa-superpowers-brainstorming: obra/superpowers@"))).toBe(true);

    const applied = await syncProject({ projectDirectory: project, packageRoot }, {
      resolveSources,
      resolveSkillSources,
    });
    const normalized = (message: string) => message
      .replace(/^Would write /u, "Wrote ")
      .replace(/^Would remove /u, "Removed ")
      .replace(/^Would update /u, "Updated ");
    expect(dryRun.messages.map(normalized)).toEqual([...applied.messages]);
    const target = path.join(project, ".opencode/skills/sherpa-superpowers-brainstorming");
    expect(readFileSync(path.join(target, "SKILL.md"))).toEqual(RAW_UPSTREAM_SKILL);
    expect(readFileSync(path.join(target, "references/sample.bin"))).toEqual(UPSTREAM_BINARY);
    expect(readFileSync(path.join(target, "SHERPA-LICENSE.txt"))).toEqual(UPSTREAM_LICENSE);
    expect(readFileSync(path.join(target, "SHERPA-SOURCE.json"))).toEqual(UPSTREAM_SOURCE);
    expect(readFileSync(path.join(project, ".opencode/skills/extra/optional-skill/SKILL.md"), "utf8"))
      .toContain("extra/optional-skill guidance.");

    writeFileSync(path.join(target, "references/sample.bin"), Buffer.from("user edit"));
    fixtureData.write(project, ".opencode/skills/user-owned/SKILL.md", "User-owned skill.\n");
    fixtureData.write(project, "opencode-sherpa.json", JSON.stringify({
      agentSources: [],
      skillSources: [],
      skills: { auto: false },
    }));
    const shrunk = await syncProject({ projectDirectory: project, packageRoot }, {
      resolveSources,
      resolveSkillSources,
    });
    expect(shrunk.messages).toContain("Removed .opencode/skills/sherpa-superpowers-brainstorming/SKILL.md");
    expect(shrunk.messages).toContain("Removed .opencode/skills/sherpa-superpowers-brainstorming/SHERPA-LICENSE.txt");
    expect(shrunk.messages).toContain("Removed .opencode/skills/sherpa-superpowers-brainstorming/SHERPA-SOURCE.json");
    expect(shrunk.messages).toContain("Removed .opencode/skills/sherpa-superpowers-brainstorming/references/guide.md");
    expect(shrunk.messages).toContain("Preserved user file .opencode/skills/sherpa-superpowers-brainstorming/references/sample.bin");
    expect(readFileSync(path.join(target, "references/sample.bin"), "utf8")).toBe("user edit");
    expect(readFileSync(path.join(project, ".opencode/skills/user-owned/SKILL.md"), "utf8")).toBe("User-owned skill.\n");
    expect(baseResolver.calls).toHaveLength(2);
    const beforeIdempotent = snapshotFiles(project);
    const secondShrink = await syncProject({ projectDirectory: project, packageRoot }, {
      resolveSources,
      resolveSkillSources,
    });
    expect(secondShrink.messages).toContain("Project is up to date.");
    expect(snapshotFiles(project)).toEqual(beforeIdempotent);
  } finally {
    fixtureData.dispose();
  }
});

test("disabled external sources keep explicit bundled skills and excluded known IDs do not fetch", async () => {
  const fixtureData = fixture();
  const project = path.join(fixtureData.root, "project");
  const packageRoot = path.join(fixtureData.root, "package");
  mkdirSync(project);
  createSelectionTuning(packageRoot);
  fixtureData.write(project, "opencode-sherpa.json", JSON.stringify({
    agentSources: [],
    skillSources: { includeDefaults: false, sources: [] },
    skills: { auto: false, include: ["extra/optional-skill"] },
  }));
  const skillFake = fakeSkillResolver();
  let agentCalls = 0;
  try {
    const result = await syncProject({ projectDirectory: project, packageRoot }, {
      resolveSkillSources: skillFake.resolveSkillSources,
      resolveSources: async () => {
        agentCalls += 1;
        return { agents: [], sources: [], diagnostics: [] };
      },
    });
    expect(skillFake.calls).toEqual([]);
    expect(agentCalls).toBe(1);
    expect(result.messages).toContain("- extra/optional-skill: Explicitly included.");
    expect(readFileSync(path.join(project, ".opencode/skills/extra/optional-skill/SKILL.md"), "utf8"))
      .toContain("extra/optional-skill guidance.");
  } finally {
    fixtureData.dispose();
  }

  const excluded = fixture();
  const excludedProject = path.join(excluded.root, "project");
  const excludedPackage = path.join(excluded.root, "package");
  mkdirSync(excludedProject);
  createSelectionTuning(excludedPackage);
  const knownId = "sherpa-superpowers-brainstorming";
  excluded.write(excludedProject, "opencode-sherpa.json", JSON.stringify({
    agentSources: [],
    skillSources: defaultSkillSourceSettings(),
    skills: { include: [knownId], exclude: [knownId] },
  }));
  const excludedFake = fakeSkillResolver();
  let excludedAgentCalls = 0;
  try {
    const result = await syncProject({ projectDirectory: excludedProject, packageRoot: excludedPackage }, {
      resolveSkillSources: excludedFake.resolveSkillSources,
      resolveSources: async () => {
        excludedAgentCalls += 1;
        return { agents: [], sources: [], diagnostics: [] };
      },
    });
    expect(excludedFake.calls).toEqual([]);
    expect(excludedAgentCalls).toBe(1);
    expect(result.messages).toContain("Selected skills: none");
    expect(() => readFileSync(path.join(excludedProject, ".opencode/skills/sherpa-superpowers-brainstorming/SKILL.md"))).toThrow();
  } finally {
    excluded.dispose();
  }
});

test("invalid skill preferences and source descriptors fail before either resolver or project writes", async () => {
  const invalidSource = { namespace: "unsafe/namespace" };
  const cases = [
    { name: "null skill selection", settings: { skills: null } },
    { name: "unknown skill include and exclude", settings: { skills: { include: ["sherpa-missing"], exclude: ["sherpa-missing"] } } },
    { name: "duplicate skill include", settings: { skills: { include: ["review", "review"] } } },
    { name: "invalid source namespace", settings: { skillSources: [invalidSource] } },
    { name: "null skill sources", settings: { skillSources: null } },
  ];
  for (const item of cases) {
    const fixtureData = fixture();
    const project = path.join(fixtureData.root, "project");
    const packageRoot = path.join(fixtureData.root, "package");
    mkdirSync(project);
    createTuning(packageRoot);
    fixtureData.write(project, "opencode-sherpa.json", JSON.stringify({ agentSources: [], skillSources: [], ...item.settings }));
    const before = snapshotFiles(project);
    let skillCalls = 0;
    let agentCalls = 0;
    try {
      await expect(syncProject({ projectDirectory: project, packageRoot }, {
        resolveSkillSources: async () => {
          skillCalls += 1;
          return { skills: [], sources: [], diagnostics: [] };
        },
        resolveSources: async () => {
          agentCalls += 1;
          return { agents: [], sources: [], diagnostics: [] };
        },
      })).rejects.toThrow();
      expect(skillCalls).toBe(0);
      expect(agentCalls).toBe(0);
      expect(snapshotFiles(project)).toEqual(before);
    } finally {
      fixtureData.dispose();
    }
  }
});

test("selected upstream resolution diagnostics and malformed results abort before project writes", async () => {
  const cases = ["diagnostic", "omitted", "duplicate", "unsafe-file"] as const;
  for (const failure of cases) {
    const fixtureData = fixture();
    const project = path.join(fixtureData.root, "project");
    const packageRoot = path.join(fixtureData.root, "package");
    mkdirSync(project);
    createTuning(packageRoot);
    fixtureData.write(project, "opencode-sherpa.json", JSON.stringify({
      agentSources: [],
      skillSources: defaultSkillSourceSettings(),
      skills: { auto: false, include: ["sherpa-superpowers-brainstorming"] },
    }));
    const before = snapshotFiles(project);
    const baseResolver = fakeSkillResolver();
    let agentCalls = 0;
    try {
      const resolveSkillSources: NonNullable<SyncDependencies["resolveSkillSources"]> = async (sources, options = {}) => {
        const resolution = await baseResolver.resolveSkillSources(sources, options);
        if (failure === "diagnostic") {
          return {
            skills: [],
            sources: [],
            diagnostics: [{
              namespace: "superpowers",
              repository: "obra/superpowers",
              commit: "8ca22dba9a94f28898bbce59f2537ff4d87c747d",
              code: "invalid-license",
              message: "Selected source license evidence is invalid.",
              skillId: "sherpa-superpowers-brainstorming",
              sourcePath: "skills/brainstorming/SKILL.md",
            }],
          };
        }
        if (failure === "omitted") return { ...resolution, skills: [], sources: [] };
        if (failure === "duplicate") return { ...resolution, skills: [...resolution.skills, ...resolution.skills] };
        return {
          ...resolution,
          skills: resolution.skills.map((skill) => ({
            ...skill,
            files: new Map([...(skill.files ?? []), ["../escape", Buffer.from("unsafe")]]),
          })),
        };
      };
      const result = syncProject({ projectDirectory: project, packageRoot }, {
        resolveSkillSources,
        resolveSources: async () => {
          agentCalls += 1;
          return { agents: [], sources: [], diagnostics: [] };
        },
      });
      if (failure === "diagnostic") {
        await expect(result).rejects.toThrow("Skill source resolution failed; project files were not changed.");
      } else {
        await expect(result).rejects.toThrow();
      }
      expect(agentCalls).toBe(0);
      expect(snapshotFiles(project)).toEqual(before);
      expect(() => readFileSync(path.join(project, "AGENTS.md"))).toThrow();
    } finally {
      fixtureData.dispose();
    }
  }
});

test("preserves user-owned command and skill files", async () => {
  const fixtureData = fixture();
  const project = path.join(fixtureData.root, "project");
  const packageRoot = path.join(fixtureData.root, "package");
  mkdirSync(project);
  createTuning(packageRoot);
  fixtureData.write(project, "opencode-sherpa.json", '{"agentSources":[],"skillSources":[],"commands":{"include":["review"]},"skills":{"include":["review"]}}\n');
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

test("global MCP servers suppress project defaults without exposing or changing credentials", async () => {
  const fixtureData = fixture();
  const project = path.join(fixtureData.root, "project");
  const packageRoot = path.join(fixtureData.root, "package");
  const globalConfigDirectory = path.join(fixtureData.root, "global-config");
  mkdirSync(project);
  createTuning(packageRoot);
  fixtureData.write(project, "opencode-sherpa.json", JSON.stringify({
    agentSources: [],
    skillSources: [],
  }));
  const globalConfig = fixtureData.write(fixtureData.root, "global-config/opencode.jsonc", `{
    "mcp": { "servers": {
      "github": { "type": "remote", "headers": { "Authorization": "Bearer global-secret-sentinel" } },
      "jina": false
    } }
  }\n`);
  const dependencies: SyncDependencies = {
    globalConfigDirectory,
    resolveSources: async () => ({ agents: [], sources: [], diagnostics: [] }),
  };
  const originalGlobalConfig = readFileSync(globalConfig, "utf8");

  try {
    const beforeDryRun = snapshotFiles(project);
    const dryRun = await syncProject({ projectDirectory: project, packageRoot, dryRun: true }, dependencies);
    expect(snapshotFiles(project)).toEqual(beforeDryRun);
    expect(dryRun.messages).toContain("Skipped global MCP server github.");
    expect(dryRun.messages).toContain("Skipped global MCP server jina.");
    expect(dryRun.messages.join("\n")).not.toContain("global-secret-sentinel");

    const applied = await syncProject({ projectDirectory: project, packageRoot }, dependencies);
    expect(applied.messages.join("\n")).not.toContain("global-secret-sentinel");
    const projectConfig = readFileSync(path.join(project, "opencode.json"), "utf8");
    const parsed = parseJsonc(projectConfig) as { mcp: { servers: Record<string, unknown> } };
    expect(parsed.mcp.servers.github).toBeUndefined();
    expect(parsed.mcp.servers.jina).toBeUndefined();
    expect(readFileSync(globalConfig, "utf8")).toBe(originalGlobalConfig);

    const beforeSecondApply = snapshotFiles(project);
    const second = await syncProject({ projectDirectory: project, packageRoot }, dependencies);
    expect(second.messages).toContain("Project is up to date.");
    expect(snapshotFiles(project)).toEqual(beforeSecondApply);
  } finally {
    fixtureData.dispose();
  }
});

test("preserves local MCP override when same-name project server takes precedence", async () => {
  const fixtureData = fixture();
  const project = path.join(fixtureData.root, "project");
  const packageRoot = path.join(fixtureData.root, "package");
  const globalConfigDirectory = path.join(fixtureData.root, "global-config");
  mkdirSync(project);
  createTuning(packageRoot);
  fixtureData.write(project, "opencode-sherpa.json", '{"agentSources":[],"skillSources":[]}\n');
  fixtureData.write(project, "opencode.jsonc", [
    "{",
    '  "mcp": { "servers": { "github": { "type": "local", "command": ["user-github"], "headers": { "Authorization": "Bearer local-secret-sentinel" } } } }',
    "}",
  ].join("\n"));
  fixtureData.write(fixtureData.root, "global-config/opencode.json", '{"mcp":{"servers":{"github":{"enabled":false}}}}\n');

  try {
    const result = await syncProject({ projectDirectory: project, packageRoot }, {
      globalConfigDirectory,
      resolveSources: async () => ({ agents: [], sources: [], diagnostics: [] }),
    });
    expect(result.messages).toContain("Preserved project MCP server github; project server takes precedence over the global server. Remove project entry manually if intended.");
    expect(result.messages.join("\n")).not.toContain("local-secret-sentinel");
    const config = readFileSync(path.join(project, "opencode.jsonc"), "utf8");
    expect(parseJsonc(config)).toMatchObject({
      mcp: { servers: { github: {
        type: "local",
        command: ["user-github"],
        headers: { Authorization: "Bearer local-secret-sentinel" },
      } } },
    });
    expect(config).toContain('"type": "local"');
  } finally {
    fixtureData.dispose();
  }
});

test("does not create project MCP config when every built-in server exists globally", async () => {
  const fixtureData = fixture();
  const project = path.join(fixtureData.root, "project");
  const packageRoot = path.join(fixtureData.root, "package");
  const globalConfigDirectory = path.join(fixtureData.root, "global-config");
  mkdirSync(project);
  createTuning(packageRoot);
  fixtureData.write(project, "opencode-sherpa.json", '{"agentSources":[],"skillSources":[]}\n');
  fixtureData.write(fixtureData.root, "global-config/opencode.json", '{"mcp":{"servers":{"github":false,"jina":false,"context7":false,"gh_grep":false}}}\n');

  try {
    const dependencies: SyncDependencies = {
      globalConfigDirectory,
      resolveSources: async () => ({ agents: [], sources: [], diagnostics: [] }),
    };
    const beforeDryRun = snapshotFiles(project);
    const dryRun = await syncProject({ projectDirectory: project, packageRoot, dryRun: true }, dependencies);
    expect(snapshotFiles(project)).toEqual(beforeDryRun);
    expect(dryRun.messages.some((message) => message.includes("write opencode.json"))).toBe(false);
    await syncProject({ projectDirectory: project, packageRoot }, dependencies);
    expect(() => readFileSync(path.join(project, "opencode.json"))).toThrow();
  } finally {
    fixtureData.dispose();
  }
});

test("adds file references for existing catalog keys in the injected global config directory", async () => {
  const fixtureData = fixture();
  const project = path.join(fixtureData.root, "project");
  const packageRoot = path.join(fixtureData.root, "package");
  const globalConfigDirectory = path.join(fixtureData.root, "global-config");
  mkdirSync(project);
  createTuning(packageRoot);
  fixtureData.write(project, "opencode-sherpa.json", JSON.stringify({
    agentSources: [],
    skillSources: [],
  }));
  fixtureData.write(fixtureData.root, "global-config/.secrets/github-key", "github secret sentinel\n");
  fixtureData.write(fixtureData.root, "global-config/.secrets/jina-key", "jina secret sentinel\n");
  fixtureData.write(fixtureData.root, "global-config/.secrets/context7-key", "context7 secret sentinel\n");
  const globalConfig = fixtureData.write(fixtureData.root, "global-config/opencode.json", '{"mcp":{"servers":{"jina":false}}}\n');

  try {
    const result = await syncProject({ projectDirectory: project, packageRoot }, {
      globalConfigDirectory,
      resolveSources: async () => ({ agents: [], sources: [], diagnostics: [] }),
    });
    const config = parseJsonc(readFileSync(path.join(project, "opencode.json"), "utf8")) as {
      mcp: { servers: Record<string, { type?: string; url?: string; oauth?: boolean; headers?: { Authorization?: string } }> };
    };
    expect(config.mcp.servers.github?.headers?.Authorization)
      .toBe(`Bearer {file:${path.join(globalConfigDirectory, ".secrets", "github-key")}}`);
    expect(config.mcp.servers.github?.oauth).toBe(false);
    expect(config.mcp.servers.context7).toEqual({
      type: "remote",
      url: "https://mcp.context7.com/mcp",
      oauth: false,
      headers: {
        Authorization: `Bearer {file:${path.join(globalConfigDirectory, ".secrets", "context7-key")}}`,
      },
    });
    expect(config.mcp.servers.jina).toBeUndefined();
    expect(config.mcp.servers.gh_grep).toEqual({ type: "remote", url: "https://mcp.grep.app" });
    expect(result.messages.join("\n")).not.toContain("sentinel");
    expect(readFileSync(globalConfig, "utf8")).toBe('{"mcp":{"servers":{"jina":false}}}\n');
  } finally {
    fixtureData.dispose();
  }
});

test("invalid global MCP config fails before source resolution and project writes, including dry-run", async () => {
  for (const dryRun of [false, true]) {
    const fixtureData = fixture();
    const project = path.join(fixtureData.root, "project");
    const packageRoot = path.join(fixtureData.root, "package");
    const globalConfigDirectory = path.join(fixtureData.root, "global-config");
    mkdirSync(project);
    createTuning(packageRoot);
    fixtureData.write(project, "opencode-sherpa.json", '{"agentSources":[],"skillSources":[]}\n');
    fixtureData.write(fixtureData.root, "global-config/opencode.json", '{"mcp":{"servers":[]}}\n');
    const before = snapshotFiles(project);
    let resolverCalls = 0;

    try {
      await expect(syncProject({ projectDirectory: project, packageRoot, dryRun }, {
        globalConfigDirectory,
        resolveSources: async () => {
          resolverCalls += 1;
          return { agents: [], sources: [], diagnostics: [] };
        },
      })).rejects.toThrow("Global OpenCode config 'mcp.servers' must be an object");
      expect(resolverCalls).toBe(0);
      expect(snapshotFiles(project)).toEqual(before);
    } finally {
      fixtureData.dispose();
    }
  }
});
