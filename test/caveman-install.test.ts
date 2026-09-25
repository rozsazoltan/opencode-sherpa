import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureCavemanInstall } from "../src/caveman-install.ts";

const SKILLS = [
  "caveman",
  "caveman-commit",
  "caveman-review",
  "caveman-help",
  "caveman-stats",
  "caveman-compress",
  "cavecrew",
] as const;
const COMMANDS = [
  "caveman.md",
  "caveman-commit.md",
  "caveman-review.md",
  "caveman-compress.md",
  "caveman-stats.md",
  "caveman-help.md",
] as const;
const AGENTS = [
  "cavecrew-investigator.md",
  "cavecrew-builder.md",
  "cavecrew-reviewer.md",
] as const;
const PLUGIN_HELPERS = [
  "plugin.js",
  "package.json",
  "caveman-config.cjs",
  "caveman-parse.cjs",
] as const;

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "opencode-sherpa-fixture-"));
  const configDirectory = path.join(root, "opencode");
  mkdirSync(configDirectory);
  return {
    root,
    configDirectory,
    payloadRoot: path.join(configDirectory, ".sherpa", "caveman", "opencode"),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

function assertFile(root: string, relative: string): void {
  const stat = lstatSync(path.join(root, ...relative.split("/")));
  expect(stat.isFile()).toBe(true);
  expect(stat.isSymbolicLink()).toBe(false);
  expect(stat.size).toBeGreaterThan(0);
}

function assertPayload(root: string): void {
  for (const name of SKILLS) assertFile(root, `skills/${name}/SKILL.md`);
  for (const name of COMMANDS) assertFile(root, `commands/${name}`);
  for (const name of AGENTS) assertFile(root, `agents/${name}`);
  for (const name of PLUGIN_HELPERS) assertFile(root, `plugins/caveman/${name}`);
  assertFile(root, "AGENTS.md");
  assertFile(root, ".sherpa-install.json");
  expect(readdirSync(path.join(root, "skills")).sort()).toEqual([...SKILLS].sort());
  expect(readdirSync(path.join(root, "commands")).sort()).toEqual([...COMMANDS].sort());
  expect(readdirSync(path.join(root, "agents")).sort()).toEqual([...AGENTS].sort());
  expect(readFileSync(path.join(root, "AGENTS.md"), "utf8")).toContain("Respond terse like smart caveman");
}

test("runs the pinned installer in isolated XDG staging and publishes a verified payload idempotently", async () => {
  const host = fixture();
  try {
    const installed = await ensureCavemanInstall(host.configDirectory);
    expect(path.isAbsolute(installed)).toBe(true);
    expect(installed).toBe(host.payloadRoot);
    assertPayload(installed);
    expect(readdirSync(host.configDirectory)).toEqual([".sherpa"]);
    const marker = readFileSync(path.join(installed, ".sherpa-install.json"), "utf8");
    expect(await ensureCavemanInstall(host.configDirectory)).toBe(installed);
    expect(readFileSync(path.join(installed, ".sherpa-install.json"), "utf8")).toBe(marker);
  } finally {
    host.dispose();
  }
});

test("derives the default config root from absolute XDG_CONFIG_HOME", async () => {
  const host = fixture();
  const previousXdg = process.env.XDG_CONFIG_HOME;
  try {
    process.env.XDG_CONFIG_HOME = host.root;
    expect(await ensureCavemanInstall()).toBe(path.join(host.root, "opencode", ".sherpa", "caveman", "opencode"));
  } finally {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    host.dispose();
  }
});

test("serializes concurrent installs into one published payload", async () => {
  const host = fixture();
  try {
    const results = await Promise.all([
      ensureCavemanInstall(host.configDirectory),
      ensureCavemanInstall(host.configDirectory),
    ]);
    expect(results).toEqual([host.payloadRoot, host.payloadRoot]);
    assertPayload(host.payloadRoot);
  } finally {
    host.dispose();
  }
});

test("refuses to reinstall when an owned payload file was tampered with", async () => {
  const host = fixture();
  try {
    await ensureCavemanInstall(host.configDirectory);
    const target = path.join(host.payloadRoot, "plugins", "caveman", "plugin.js");
    const original = readFileSync(target, "utf8");
    writeFileSync(target, `${original}\n// user edit\n`);
    await expect(ensureCavemanInstall(host.configDirectory)).rejects.toThrow("was modified");
    expect(readFileSync(target, "utf8")).toBe(`${original}\n// user edit\n`);
  } finally {
    host.dispose();
  }
});

test("refuses malformed and foreign existing .sherpa/caveman directories without changing them", async () => {
  const foreign = fixture();
  try {
    const cavemanDirectory = path.join(foreign.configDirectory, ".sherpa", "caveman");
    mkdirSync(cavemanDirectory, { recursive: true });
    writeFileSync(path.join(cavemanDirectory, "user-data.txt"), "keep");
    await expect(ensureCavemanInstall(foreign.configDirectory)).rejects.toThrow("foreign existing");
    expect(readFileSync(path.join(cavemanDirectory, "user-data.txt"), "utf8")).toBe("keep");
  } finally {
    foreign.dispose();
  }

  const malformed = fixture();
  try {
    mkdirSync(malformed.payloadRoot, { recursive: true });
    const markerPath = path.join(malformed.payloadRoot, ".sherpa-install.json");
    writeFileSync(markerPath, "not-json");
    await expect(ensureCavemanInstall(malformed.configDirectory)).rejects.toThrow("malformed");
    expect(readFileSync(markerPath, "utf8")).toBe("not-json");
  } finally {
    malformed.dispose();
  }
});

test("refuses a symlinked .sherpa/caveman path", async () => {
  const host = fixture();
  const outside = mkdtempSync(path.join(os.tmpdir(), "opencode-sherpa-outside-"));
  try {
    const sherpaDirectory = path.join(host.configDirectory, ".sherpa");
    mkdirSync(sherpaDirectory);
    const targetFile = path.join(outside, "user-data.txt");
    writeFileSync(targetFile, "keep");
    const link = path.join(sherpaDirectory, "caveman");
    try {
      symlinkSync(outside, link, "dir");
    } catch (error) {
      if (process.platform === "win32" && ["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
      throw error;
    }
    await expect(ensureCavemanInstall(host.configDirectory)).rejects.toThrow("real directory");
    expect(existsSync(link)).toBe(true);
    expect(readFileSync(targetFile, "utf8")).toBe("keep");
  } finally {
    host.dispose();
    rmSync(outside, { recursive: true, force: true });
  }
});
