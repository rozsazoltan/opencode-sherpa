import { expect, test } from "bun:test";
import { computeNextReleaseVersion } from "../scripts/release/next-version.ts";

test("starts current month release sequence at one", () => {
  expect(computeNextReleaseVersion(new Date("2026-10-02T12:00:00Z"), {
    tags: [],
    branches: [],
    packageVersions: ["0.1.0"],
  })).toBe("2026.10.1");
});

test("uses highest current-month tag, branch, and package version", () => {
  expect(computeNextReleaseVersion(new Date("2026-10-02T12:00:00Z"), {
    tags: ["v2026.10.1", "refs/tags/v2026.10.3", "v2026.09.99"],
    branches: ["refs/heads/chore/release-v2026.10.4"],
    packageVersions: ["2026.10.2", "2026.09.100"],
  })).toBe("2026.10.5");
});

test("uses UTC month and ignores malformed release refs", () => {
  expect(computeNextReleaseVersion(new Date("2026-01-01T00:30:00+14:00"), {
    tags: ["v2025.12.8", "v2026.1.9", "not-a-release"],
    branches: ["chore/release-v2026.01.2"],
    packageVersions: ["2026.01.1"],
  })).toBe("2025.12.9");
});

test("rejects invalid dates", () => {
  expect(() => computeNextReleaseVersion(new Date(Number.NaN), {
    tags: [],
    branches: [],
    packageVersions: [],
  })).toThrow("Release date is invalid");
});
