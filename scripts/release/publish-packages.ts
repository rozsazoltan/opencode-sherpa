import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const expectedVersion = process.env.RELEASE_VERSION ?? "";
if (!/^\d{4}\.(?:0[1-9]|1[0-2])\.[1-9]\d*$/.test(expectedVersion)) {
  throw new Error("RELEASE_VERSION is missing or invalid");
}

const packages = [
  { directory: ".", manifest: "package.json", name: "@rozsazoltan/opencode-sherpa" },
  { directory: "plugin", manifest: "plugin/package.json", name: "@rozsazoltan/opencode-sherpa-plugin" },
];

for (const item of packages) {
  const manifest: unknown = JSON.parse(readFileSync(item.manifest, "utf8"));
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !("name" in manifest) ||
    !("version" in manifest) ||
    manifest.name !== item.name ||
    manifest.version !== expectedVersion
  ) {
    throw new Error(`${item.manifest} does not match release ${expectedVersion}`);
  }

  const existing = spawnSync(
    "npm",
    ["view", `${item.name}@${expectedVersion}`, "version", "--registry=https://registry.npmjs.org"],
    { encoding: "utf8" },
  );
  if (existing.status === 0) {
    console.log(`${item.name}@${expectedVersion} already exists; skipping publish`);
    continue;
  }
  if (!`${existing.stdout}\n${existing.stderr}`.includes("E404")) {
    throw new Error(`Could not check ${item.name}@${expectedVersion}: ${existing.stderr}`);
  }

  execFileSync("npm", ["publish", item.directory, "--access", "public"], { stdio: "inherit" });
}
