import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
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
    fixtureData.write(project, "opencode-sherpa.jsonc", '{"agentSources":[]}\n');
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
  fixtureData.write(project, "opencode-sherpa.json", '{"agentSources":[]}\n');
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

test("source resolution failure exits clearly without changing project files", async () => {
  const fixtureData = fixture();
  const project = path.join(fixtureData.root, "project");
  mkdirSync(project);
  const settings = fixtureData.write(project, "opencode-sherpa.json", '{"agentSources":[]}\n');
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
    expect(readFileSync(settings, "utf8")).toBe('{"agentSources":[]}\n');
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
  fixtureData.write(project, "opencode-sherpa.json", '{"agentSources":[]}\n');
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
