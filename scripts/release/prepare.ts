import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { computeNextReleaseVersion } from "./next-version.ts";

interface PackageManifest {
  readonly name: string;
  readonly version: string;
}

interface OpenPullRequest {
  readonly headRefName: string;
  readonly url: string;
}

function run(command: string, args: readonly string[]): string {
  return execFileSync(command, [...args], { encoding: "utf8" }).trim();
}

function readManifest(path: string): PackageManifest {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    typeof value !== "object" ||
    value === null ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    !("version" in value) ||
    typeof value.version !== "string"
  ) {
    throw new Error(`Package manifest is invalid: ${path}`);
  }
  return { name: value.name, version: value.version };
}

function writeVersion(path: string, version: string): void {
  const manifest: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof manifest !== "object" || manifest === null || !("version" in manifest)) {
    throw new Error(`Package manifest has no version: ${path}`);
  }
  const updated = { ...manifest, version };
  writeFileSync(path, `${JSON.stringify(updated, null, 2)}\n`);
}

function main(): void {
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("GITHUB_REPOSITORY is missing or invalid");
  }
  if (run("git", ["status", "--porcelain"])) throw new Error("Release preparation requires a clean checkout");

  const date = new Date();
  const yearMonth = `${date.getUTCFullYear()}.${String(date.getUTCMonth() + 1).padStart(2, "0")}.`;
  const openPullRequests = JSON.parse(
    run("gh", ["pr", "list", "--repo", repository, "--base", "master", "--state", "open", "--json", "headRefName,url"]),
  ) as OpenPullRequest[];
  const existing = openPullRequests.find((pullRequest) =>
    new RegExp(`^chore/release-v${yearMonth.replaceAll(".", "\\.")}\\d+$`).test(pullRequest.headRefName),
  );
  if (existing) {
    console.log(`Release preparation already exists: ${existing.url}`);
    return;
  }

  const tags = run("git", ["tag", "--list"]).split(/\r?\n/).filter(Boolean);
  const branches = run("git", ["ls-remote", "--heads", "origin", "refs/heads/chore/release-v*"])
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split(/\s+/).at(-1) ?? line);
  const packageVersions = ["package.json", "plugin/package.json"].map((path) => readManifest(path).version);
  const version = computeNextReleaseVersion(date, { tags, branches, packageVersions });
  const branch = `chore/release-v${version}`;
  const title = `chore: prepare v${version} release`;

  run("git", ["switch", "-c", branch]);
  writeVersion("package.json", version);
  writeVersion("plugin/package.json", version);
  run("git", ["add", "package.json", "plugin/package.json"]);
  run("git", [
    "-c",
    "user.name=github-actions[bot]",
    "-c",
    "user.email=41898282+github-actions[bot]@users.noreply.github.com",
    "commit",
    "-m",
    title,
  ]);
  run("git", ["push", "--set-upstream", "origin", branch]);

  const body = [
    `Prepare shared CLI/plugin release ${version}.`,
    "",
    "This PR contains one automated version-bump commit. Add related release changes here if needed.",
    "Merging publishes both npm packages, creates the matching GitHub release/tag, and deletes this branch.",
    "",
    "- [ ] Review both package versions and any release-specific changes.",
    "- [ ] Confirm npm Trusted Publishing is configured for both packages using `.github/workflows/publish.yml`.",
  ].join("\n");
  const url = run("gh", ["pr", "create", "--repo", repository, "--base", "master", "--head", branch, "--title", title, "--body", body]);
  console.log(url);
}

main();
