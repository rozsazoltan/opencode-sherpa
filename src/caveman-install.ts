import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const INSTALLER_ROOT = fileURLToPath(new URL(".", import.meta.resolve("caveman-installer/package.json")));
const INSTALLER_VERSION = (JSON.parse(readFileSync(path.join(INSTALLER_ROOT, "package.json"), "utf8")) as {
  version: string;
}).version;
const INSTALLER_ARGS = ["bin/install.js", "--only", "opencode", "--non-interactive", "--no-mcp-shrink"];
const INSTALL_MARKER = ".sherpa-install.json";
const LOCK_NAME = ".caveman-install.lock";
const LOCK_TIMEOUT_MS = 120_000;
const EXPECTED_SKILLS = [
  "caveman",
  "caveman-commit",
  "caveman-review",
  "caveman-help",
  "caveman-stats",
  "caveman-compress",
  "cavecrew",
] as const;
const EXPECTED_COMMANDS = [
  "caveman.md",
  "caveman-commit.md",
  "caveman-review.md",
  "caveman-compress.md",
  "caveman-stats.md",
  "caveman-help.md",
] as const;
const EXPECTED_AGENTS = [
  "cavecrew-investigator.md",
  "cavecrew-builder.md",
  "cavecrew-reviewer.md",
] as const;
const EXPECTED_PLUGIN_FILES = [
  "plugin.js",
  "package.json",
  "caveman-config.cjs",
  "caveman-parse.cjs",
] as const;
const AGENTS_SENTINEL = "Respond terse like smart caveman";

interface PayloadManifest {
  directories: string[];
  files: Record<string, string>;
}

interface InstallMarker {
  version: 1;
  installer: "caveman-installer";
  installerVersion: string;
  manifest: PayloadManifest;
  digest: string;
}

type JsonObject = Record<string, unknown>;

class InstallError extends Error {}

function object(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function codeOf(error: unknown): string | undefined {
  return object(error) && typeof error.code === "string" ? error.code : undefined;
}

function defaultConfigDirectory(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), ".config");
  return path.resolve(base, "opencode");
}

function lstatOrNull(target: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(target);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return null;
    throw error;
  }
}

function assertDirectory(target: string, message: string): void {
  const stat = lstatOrNull(target);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) throw new InstallError(message);
}

function ensureDirectory(target: string, message: string): boolean {
  if (lstatOrNull(target)) {
    assertDirectory(target, message);
    return false;
  }
  try {
    mkdirSync(target, { mode: 0o700 });
  } catch (error) {
    if (codeOf(error) !== "EEXIST") throw error;
  }
  assertDirectory(target, message);
  return true;
}

function ensureConfigDirectory(target: string): void {
  mkdirSync(target, { recursive: true, mode: 0o700 });
  assertDirectory(target, "The global OpenCode config directory is not a real directory.");
}

async function acquireLock(sherpaDirectory: string): Promise<() => void> {
  const lockDirectory = path.join(sherpaDirectory, LOCK_NAME);
  const deadline = performance.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      mkdirSync(lockDirectory, { mode: 0o700 });
      return () => {
        try {
          rmdirSync(lockDirectory);
        } catch {
          // Never recursively remove a lock path that may have been replaced.
        }
      };
    } catch (error) {
      if (codeOf(error) !== "EEXIST") throw error;
      assertDirectory(lockDirectory, "A conflicting installer lock path exists.");
      if (performance.now() >= deadline) {
        throw new InstallError("Another Caveman payload install is still running; check for a stale lock.");
      }
      await delay(50);
    }
  }
}

function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalManifest(manifest: PayloadManifest): PayloadManifest {
  const files: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const name of Object.keys(manifest.files).sort()) files[name] = manifest.files[name]!;
  return { directories: [...manifest.directories].sort(), files };
}

function manifestDigest(manifest: PayloadManifest): string {
  return sha256(JSON.stringify(canonicalManifest(manifest)));
}

function relativeName(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join("/");
}

function scanPayload(root: string): PayloadManifest {
  const files: Record<string, string> = Object.create(null) as Record<string, string>;
  const directories: string[] = [];

  function visit(directory: string): void {
    for (const name of readdirSync(directory).sort()) {
      const target = path.join(directory, name);
      const stat = lstatSync(target);
      const relative = relativeName(root, target);
      if (stat.isSymbolicLink()) throw new InstallError("The staged Caveman payload contains a symbolic link.");
      if (stat.isDirectory()) {
        directories.push(relative);
        visit(target);
      } else if (stat.isFile()) {
        if (relative !== INSTALL_MARKER) files[relative] = sha256(readFileSync(target));
      } else {
        throw new InstallError("The staged Caveman payload contains an unsupported file type.");
      }
    }
  }

  visit(root);
  return canonicalManifest({ directories, files });
}

function safeRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value === "" || value.startsWith("/") || value.includes("\\")) return false;
  const parts = value.split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== "..") &&
    value !== INSTALL_MARKER;
}

function isManifest(value: unknown): value is PayloadManifest {
  if (!object(value) || !Array.isArray(value.directories) || !object(value.files)) return false;
  const files = value.files;
  if (!value.directories.every((item) => safeRelativePath(item))) return false;
  if (new Set(value.directories).size !== value.directories.length) return false;
  const names = Object.keys(files);
  if (names.some((name) => !safeRelativePath(name))) return false;
  if (new Set(names).size !== names.length) return false;
  if (!names.every((name) => typeof files[name] === "string" && /^[a-f0-9]{64}$/u.test(files[name] as string))) {
    return false;
  }
  return true;
}

function readMarker(root: string): InstallMarker {
  const markerPath = path.join(root, INSTALL_MARKER);
  const stat = lstatOrNull(markerPath);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
    throw new InstallError("The existing Caveman payload has no valid Sherpa install marker.");
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(markerPath, "utf8")) as unknown;
  } catch {
    throw new InstallError("The existing Caveman install marker is malformed.");
  }
  if (!object(value) || value.version !== 1 || value.installer !== "caveman-installer" ||
      value.installerVersion !== INSTALLER_VERSION || !isManifest(value.manifest) ||
      typeof value.digest !== "string" || !/^[a-f0-9]{64}$/u.test(value.digest) ||
      value.digest !== manifestDigest(value.manifest)) {
    throw new InstallError("The existing Caveman install marker is invalid or from another installer version.");
  }
  return value as unknown as InstallMarker;
}

function assertRegularFile(root: string, relative: string): void {
  const target = path.join(root, ...relative.split("/"));
  const stat = lstatOrNull(target);
  if (!stat || stat.isSymbolicLink() || !stat.isFile() || stat.size === 0) {
    throw new InstallError("The pinned installer did not produce the complete Caveman payload.");
  }
}

function assertExpectedPayload(root: string): void {
  for (const name of EXPECTED_PLUGIN_FILES) assertRegularFile(root, `plugins/caveman/${name}`);
  for (const name of EXPECTED_COMMANDS) assertRegularFile(root, `commands/${name}`);
  for (const name of EXPECTED_AGENTS) assertRegularFile(root, `agents/${name}`);
  for (const name of EXPECTED_SKILLS) assertRegularFile(root, `skills/${name}/SKILL.md`);
  assertRegularFile(root, "AGENTS.md");
  if (!readFileSync(path.join(root, "AGENTS.md"), "utf8").includes(AGENTS_SENTINEL)) {
    throw new InstallError("The pinned installer produced an unexpected AGENTS.md payload.");
  }
}

function verifyInstallation(root: string): void {
  assertDirectory(root, "The existing Caveman payload path is not a real directory.");
  const marker = readMarker(root);
  assertExpectedPayload(root);
  const actual = scanPayload(root);
  if (JSON.stringify(actual) !== JSON.stringify(canonicalManifest(marker.manifest))) {
    throw new InstallError("The installed Caveman payload was modified; refusing to overwrite it.");
  }
}

function copyPath(source: string, target: string): void {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) throw new InstallError("The pinned installer emitted a symbolic link.");
  if (stat.isDirectory()) {
    mkdirSync(target, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(source).sort()) copyPath(path.join(source, name), path.join(target, name));
    return;
  }
  if (!stat.isFile()) throw new InstallError("The pinned installer emitted an unsupported file type.");
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  copyFileSync(source, target);
}

function copyFile(sourceRoot: string, relative: string, targetRoot: string): void {
  copyPath(path.join(sourceRoot, ...relative.split("/")), path.join(targetRoot, ...relative.split("/")));
}

function materializePayload(installedConfig: string, targetRoot: string): void {
  assertDirectory(installedConfig, "The pinned installer did not produce an OpenCode staging tree.");
  scanPayload(installedConfig);
  mkdirSync(targetRoot, { mode: 0o700 });
  copyPath(path.join(installedConfig, "plugins", "caveman"), path.join(targetRoot, "plugins", "caveman"));
  for (const name of EXPECTED_COMMANDS) copyFile(installedConfig, `commands/${name}`, targetRoot);
  for (const name of EXPECTED_AGENTS) copyFile(installedConfig, `agents/${name}`, targetRoot);
  for (const name of EXPECTED_SKILLS) copyPath(
    path.join(installedConfig, "skills", name),
    path.join(targetRoot, "skills", name),
  );
  copyFile(installedConfig, "AGENTS.md", targetRoot);
  assertExpectedPayload(targetRoot);
}

function writeInstallMarker(root: string): void {
  const manifest = scanPayload(root);
  const marker: InstallMarker = {
    version: 1,
    installer: "caveman-installer",
    installerVersion: INSTALLER_VERSION,
    manifest,
    digest: manifestDigest(manifest),
  };
  writeFileSync(path.join(root, INSTALL_MARKER), `${JSON.stringify(marker, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}

function copyDirectoryContents(source: string, target: string): void {
  for (const name of readdirSync(source).sort()) copyPath(path.join(source, name), path.join(target, name));
}

async function runInstaller(xdgConfigHome: string): Promise<void> {
  const temp = path.join(xdgConfigHome, "tmp");
  mkdirSync(temp, { mode: 0o700 });
  const pathValue = process.env.PATH ?? process.env.Path;
  const env: Record<string, string> = {
    XDG_CONFIG_HOME: xdgConfigHome,
    HOME: xdgConfigHome,
    USERPROFILE: xdgConfigHome,
    APPDATA: path.join(xdgConfigHome, "AppData", "Roaming"),
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
  };
  if (pathValue) env.PATH = pathValue;
  for (const name of ["SystemRoot", "windir", "ComSpec", "PATHEXT"] as const) {
    const value = process.env[name];
    if (value) env[name] = value;
  }

  await new Promise<void>((resolve, reject) => {
    const child = execFile("node", INSTALLER_ARGS, {
      cwd: INSTALLER_ROOT,
      env,
      shell: false,
      windowsHide: true,
      timeout: LOCK_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    }, (error) => {
      if (error) reject(error);
      else resolve();
    });
    child.stdin?.end();
  }).catch(() => {
    throw new InstallError("The pinned Caveman installer failed in its isolated staging directory.");
  });
}

/** Installs and verifies the pinned OpenCode payload under the global config's Sherpa directory. */
export async function ensureCavemanInstall(configDirectory?: string): Promise<string> {
  const configRoot = path.resolve(configDirectory ?? defaultConfigDirectory());
  let scratchRoot: string | undefined;
  let publishStage: string | undefined;
  let createdCavemanDirectory: string | undefined;
  let publishedPayloadRoot: string | undefined;
  try {
    ensureConfigDirectory(configRoot);
    const sherpaDirectory = path.join(configRoot, ".sherpa");
    ensureDirectory(sherpaDirectory, "The .sherpa path must be a real directory.");
    const unlock = await acquireLock(sherpaDirectory);
    try {
      assertDirectory(sherpaDirectory, "The .sherpa path must be a real directory.");
      const cavemanDirectory = path.join(sherpaDirectory, "caveman");
      if (ensureDirectory(cavemanDirectory, "The .sherpa/caveman path must be a real directory.")) {
        createdCavemanDirectory = cavemanDirectory;
      }
      const payloadRoot = path.join(cavemanDirectory, "opencode");
      publishedPayloadRoot = payloadRoot;
      const existing = lstatOrNull(payloadRoot);
      if (existing) {
        verifyInstallation(payloadRoot);
        return path.resolve(payloadRoot);
      }
      if (!createdCavemanDirectory || readdirSync(cavemanDirectory).length > 0) {
        throw new InstallError("Refusing to use a foreign existing .sherpa/caveman directory.");
      }

      scratchRoot = mkdtempSync(path.join(os.tmpdir(), "opencode-sherpa-caveman-"));
      const xdgConfigHome = path.join(scratchRoot, "xdg");
      mkdirSync(xdgConfigHome, { mode: 0o700 });
      const payloadStageInTemp = path.join(scratchRoot, "payload");
      await runInstaller(xdgConfigHome);
      materializePayload(path.join(xdgConfigHome, "opencode"), payloadStageInTemp);
      writeInstallMarker(payloadStageInTemp);
      verifyInstallation(payloadStageInTemp);

      publishStage = mkdtempSync(path.join(cavemanDirectory, ".opencode-stage-"));
      copyDirectoryContents(payloadStageInTemp, publishStage);
      verifyInstallation(publishStage);
      if (lstatOrNull(payloadRoot)) {
        throw new InstallError("An OpenCode payload appeared during installation; refusing to replace it.");
      }
      renameSync(publishStage, payloadRoot);
      publishStage = undefined;
      verifyInstallation(payloadRoot);
      return path.resolve(payloadRoot);
    } finally {
      unlock();
    }
  } catch (error) {
    if (error instanceof InstallError) throw error;
    throw new InstallError("Caveman payload installation failed safely; existing files were left untouched.");
  } finally {
    if (publishStage) {
      try {
        rmSync(publishStage, { recursive: true, force: true });
      } catch {
        // Cleanup is best-effort and limited to this invocation's private stage.
      }
    }
    if (scratchRoot) {
      try {
        rmSync(scratchRoot, { recursive: true, force: true });
      } catch {
        // Cleanup is best-effort and limited to this invocation's private stage.
      }
    }
    if (createdCavemanDirectory && publishedPayloadRoot) {
      try {
        if (!lstatOrNull(publishedPayloadRoot)) rmdirSync(createdCavemanDirectory);
      } catch {
        // Remove only this call's empty parent; never recurse into user content.
      }
    }
  }
}
