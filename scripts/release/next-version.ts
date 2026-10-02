import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ReleaseVersionSources {
  readonly tags: readonly string[];
  readonly branches: readonly string[];
  readonly packageVersions: readonly string[];
}

function parseReleaseVersion(reference: string): string | undefined {
  let candidate = reference.trim().split(/\s+/).at(-1) ?? "";
  if (candidate.startsWith("refs/tags/")) candidate = candidate.slice("refs/tags/".length);
  if (candidate.startsWith("refs/heads/")) candidate = candidate.slice("refs/heads/".length);
  if (candidate.startsWith("chore/release-v")) candidate = candidate.slice("chore/release-v".length);
  else if (candidate.startsWith("v")) candidate = candidate.slice(1);

  return /^\d{4}\.(?:0[1-9]|1[0-2])\.[1-9]\d*$/.test(candidate) ? candidate : undefined;
}

export function computeNextReleaseVersion(date: Date, sources: ReleaseVersionSources): string {
  if (Number.isNaN(date.getTime())) throw new Error("Release date is invalid");

  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const monthPrefix = `${year}.${month}.`;
  let highestSequence = 0;

  for (const reference of [...sources.tags, ...sources.branches, ...sources.packageVersions]) {
    const version = parseReleaseVersion(reference);
    if (!version?.startsWith(monthPrefix)) continue;

    const sequence = Number(version.slice(monthPrefix.length));
    if (!Number.isSafeInteger(sequence)) throw new Error(`Release sequence is too large: ${version}`);
    highestSequence = Math.max(highestSequence, sequence);
  }

  if (highestSequence === Number.MAX_SAFE_INTEGER) throw new Error("Release sequence is exhausted");
  return `${monthPrefix}${highestSequence + 1}`;
}

function gitLines(args: readonly string[]): string[] {
  return execFileSync("git", [...args], { encoding: "utf8" })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function run(): void {
  const tags = gitLines(["tag", "--list"]);
  const branches = gitLines(["ls-remote", "--heads", "origin", "refs/heads/chore/release-v*"])
    .map((line) => line.split(/\s+/).at(-1) ?? line);
  const packageVersions = ["package.json", "plugin/package.json"].map((path) => {
    const manifest: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof manifest !== "object" || manifest === null || !("version" in manifest)) {
      throw new Error(`Package manifest has no version: ${path}`);
    }
    const version = manifest.version;
    if (typeof version !== "string") throw new Error(`Package version is invalid: ${path}`);
    return version;
  });

  process.stdout.write(`${computeNextReleaseVersion(new Date(), { tags, branches, packageVersions })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
