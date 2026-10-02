import { expect, test } from "bun:test";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const launcherRelativePath = "bin/sherpa.js";

function createFixture() {
  const temporaryParent = path.join(os.tmpdir(), "opencode");
  mkdirSync(temporaryParent, { recursive: true });
  const root = mkdtempSync(path.join(temporaryParent, "sherpa-launcher-test-"));
  const packageRoot = path.join(root, "node_modules", "opencode-sherpa");
  const write = (relative: string, contents: string) => {
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
    return target;
  };

  mkdirSync(packageRoot, { recursive: true });
  for (const directory of ["bin", "src", "tuning"]) {
    cpSync(path.join(repositoryRoot, directory), path.join(packageRoot, directory), { recursive: true });
  }
  cpSync(path.join(repositoryRoot, "package.json"), path.join(packageRoot, "package.json"));
  cpSync(path.join(repositoryRoot, "LICENSE"), path.join(packageRoot, "LICENSE"));

  const dependencies = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };
  const modulesRoot = path.join(root, "node_modules");
  for (const dependency of Object.keys(dependencies.dependencies)) {
    symlinkSync(path.join(repositoryRoot, "node_modules", dependency), path.join(modulesRoot, dependency), "dir");
  }

  return {
    root,
    packageRoot,
    projectRoot: path.join(root, "project"),
    launcherPath: path.join(packageRoot, launcherRelativePath),
    write,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

function snapshotFiles(directory: string): Map<string, string> {
  const files = new Map<string, string>();
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) files.set(path.relative(directory, target), readFileSync(target, "utf8"));
    }
  };
  visit(directory);
  return files;
}

function run(executable: string, launcherPath: string, args: readonly string[], cwd: string) {
  return spawnSync(executable, [launcherPath, ...args], { cwd, encoding: "utf8" });
}

function projectSettings(fixture: ReturnType<typeof createFixture>): void {
  mkdirSync(fixture.projectRoot, { recursive: true });
  fixture.write("project/opencode-sherpa.json", '{"agentSources":[],"skillSources":[]}\n');
}

test("Node and Bun launch packaged TypeScript CLI and preserve CLI status codes", () => {
  const fixture = createFixture();
  projectSettings(fixture);
  const launcherStat = lstatSync(path.join(repositoryRoot, launcherRelativePath));
  const packageManifest = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8")) as {
    bin: { sherpa: string };
    files: string[];
  };

  try {
    expect(packageManifest.bin.sherpa).toBe(`./${launcherRelativePath}`);
    expect(packageManifest.files).toContain("bin/");
    expect(launcherStat.mode & 0o111).not.toBe(0);

    const nodeHelp = run("node", fixture.launcherPath, ["--help"], fixture.projectRoot);
    expect(nodeHelp.status).toBe(0);
    expect(nodeHelp.stdout).toContain("Usage: sherpa sync [--project <path>] [--dry-run]");
    expect(nodeHelp.stdout.match(/Commands: sync/g)).toHaveLength(1);

    const beforeDryRun = snapshotFiles(fixture.projectRoot);
    const nodeDryRun = run("node", fixture.launcherPath, ["sync", "--project", fixture.projectRoot, "--dry-run"], fixture.root);
    expect(nodeDryRun.status).toBe(0);
    expect(nodeDryRun.stdout).toContain("Selected agents: none");
    expect(nodeDryRun.stdout).toContain("Selected skills: none");
    expect(snapshotFiles(fixture.projectRoot)).toEqual(beforeDryRun);

    const firstApply = run("node", fixture.launcherPath, ["sync", "--project", fixture.projectRoot], fixture.root);
    expect(firstApply.status).toBe(0);
    expect(firstApply.stdout).toContain("Wrote AGENTS.md");
    const secondApply = run("node", fixture.launcherPath, ["sync", "--project", fixture.projectRoot], fixture.root);
    expect(secondApply.status).toBe(0);
    expect(secondApply.stdout).toContain("Project is up to date.");

    const invalidArguments = run("node", fixture.launcherPath, ["unknown-command"], fixture.root);
    expect(invalidArguments.status).toBe(2);
    expect(invalidArguments.stderr).toContain("Unknown command: unknown-command");

    const invalidProject = path.join(fixture.root, "invalid-project");
    mkdirSync(invalidProject);
    writeFileSync(path.join(invalidProject, "opencode-sherpa.json"), "{invalid\n");
    const invalidConfiguration = run("node", fixture.launcherPath, ["sync", "--project", invalidProject], fixture.root);
    expect(invalidConfiguration.status).toBe(1);
    expect(invalidConfiguration.stderr).toContain("is malformed.");
    expect(snapshotFiles(invalidProject)).toEqual(new Map([["opencode-sherpa.json", "{invalid\n"]]));

    const bunHelp = run(process.execPath, fixture.launcherPath, ["--help"], fixture.projectRoot);
    expect(bunHelp.status).toBe(0);
    expect(bunHelp.stdout).toContain("Usage: sherpa sync [--project <path>] [--dry-run]");
    expect(bunHelp.stdout.match(/Commands: sync/g)).toHaveLength(1);

    const bunDryRun = run(process.execPath, fixture.launcherPath, ["sync", "--project", fixture.projectRoot, "--dry-run"], fixture.root);
    expect(bunDryRun.status).toBe(0);
    expect(bunDryRun.stdout).toContain("Selected agents: none");
    expect(bunDryRun.stdout).toContain("Selected skills: none");
  } finally {
    fixture.dispose();
  }
});

test("Node loader hook leaves TypeScript outside packaged src to native Node handling", () => {
  for (const [relativeSource, importPath] of [
    ["outside.ts", "../outside.ts"],
    ["src-neighbor/probe.ts", "../src-neighbor/probe.ts"],
  ] as const) {
    const fixture = createFixture();
    try {
      const externalSource = path.join(fixture.packageRoot, relativeSource);
      mkdirSync(path.dirname(externalSource), { recursive: true });
      writeFileSync(externalSource, 'export const marker: string = "external";\n');
      const cliPath = path.join(fixture.packageRoot, "src", "cli.ts");
      const cliSource = readFileSync(cliPath, "utf8");
      writeFileSync(cliPath, `${cliSource.replace(/^#!.*\n/u, "")}\nimport "${importPath}";\n`);

      const result = run("node", fixture.launcherPath, ["--help"], fixture.root);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING");
    } finally {
      fixture.dispose();
    }
  }
});
