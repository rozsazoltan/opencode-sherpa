import { appendFileSync, readFileSync } from "node:fs";

const branch = process.env.RELEASE_BRANCH ?? "";
const title = process.env.RELEASE_TITLE ?? "";
const match = /^chore\/release-v(\d{4}\.(?:0[1-9]|1[0-2])\.[1-9]\d*)$/.exec(branch);
if (!match) throw new Error(`Unexpected release branch: ${branch}`);

const version = match[1];
if (title !== `chore: prepare v${version} release`) {
  throw new Error(`Release PR title does not match version ${version}`);
}

const expectedPackages = new Map([
  ["package.json", "@rozsazoltan/opencode-sherpa"],
  ["plugin/package.json", "@rozsazoltan/opencode-sherpa-plugin"],
]);
for (const [path, expectedName] of expectedPackages) {
  const manifest: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof manifest !== "object" || manifest === null || !("name" in manifest) || !("version" in manifest)) {
    throw new Error(`Package manifest is invalid: ${path}`);
  }
  if (manifest.name !== expectedName || manifest.version !== version) {
    throw new Error(`${path} must publish ${expectedName}@${version}`);
  }
}

const output = process.env.GITHUB_OUTPUT;
if (output) appendFileSync(output, `version=${version}\n`);
console.log(`Validated release ${version}`);
