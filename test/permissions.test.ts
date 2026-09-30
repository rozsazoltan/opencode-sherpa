import { expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import type { PermissionEvaluation } from "@opencode/plugin/promise/permission";
import { createDirectoryPermissionEvaluator, type PathApi } from "../src/permissions.ts";

type PermissionDecision = Pick<PermissionEvaluation, "action" | "effect" | "resources">;

function createEvaluation(
  action: string,
  effect: PermissionEvaluation["effect"],
  resources: string[],
): PermissionDecision {
  return { action, effect, resources };
}

const defaultDirectory = path.join(os.tmpdir(), "opencode");

test("auto-allows literal read, edit, and external-directory resources under the default temp subtree", () => {
  const evaluate = createDirectoryPermissionEvaluator({});

  for (const action of ["external_directory", "read", "edit"]) {
    const evaluation = createEvaluation(action, "ask", [path.join(defaultDirectory, "nested", "file.txt")]);
    evaluate(evaluation);
    expect(evaluation.effect).toBe("allow");
  }

  const directoryGate = createEvaluation("external_directory", "ask", [defaultDirectory]);
  evaluate(directoryGate);
  expect(directoryGate.effect).toBe("allow");

  const broaderGate = createEvaluation("external_directory", "ask", [os.tmpdir()]);
  evaluate(broaderGate);
  expect(broaderGate.effect).toBe("ask");
});

test("adds configured allow directories without removing the default and requires every resource to match", () => {
  const extraDirectory = path.join(os.tmpdir(), "sherpa-extra");
  const evaluate = createDirectoryPermissionEvaluator({
    permissions: { allowDirectories: [extraDirectory] },
  });

  for (const resource of [
    path.join(defaultDirectory, "file.txt"),
    path.join(extraDirectory, "file.txt"),
  ]) {
    const evaluation = createEvaluation("read", "ask", [resource]);
    evaluate(evaluation);
    expect(evaluation.effect).toBe("allow");
  }

  const mixedResources = createEvaluation("read", "ask", [
    path.join(defaultDirectory, "inside.txt"),
    path.join(os.tmpdir(), "outside", "file.txt"),
  ]);
  evaluate(mixedResources);
  expect(mixedResources.effect).toBe("ask");
});

test("accepts only literal paths or one bounded terminal /* resource", () => {
  const evaluate = createDirectoryPermissionEvaluator({});

  for (const resource of [
    `${defaultDirectory}/*`,
    `${defaultDirectory}/nested/*`,
  ]) {
    const evaluation = createEvaluation("external_directory", "ask", [resource]);
    evaluate(evaluation);
    expect(evaluation.effect).toBe("allow");
  }

  for (const resource of [
    `${defaultDirectory}/**`,
    `${defaultDirectory}/*/child`,
    `${defaultDirectory}/file?.txt`,
    `${defaultDirectory}/[ab].txt`,
    `${defaultDirectory}/!(private)`,
    `${defaultDirectory}-sibling/file.txt`,
    `${defaultDirectory}/../outside/file.txt`,
    "relative/file.txt",
  ]) {
    const evaluation = createEvaluation("read", "ask", [resource]);
    evaluate(evaluation);
    expect(evaluation.effect).toBe("ask");
  }
});

test("exclusions deny contained resources and broad directory capabilities, even when already allowed", () => {
  const excludedDirectory = path.join(defaultDirectory, "private");
  const evaluate = createDirectoryPermissionEvaluator({
    permissions: { denyDirectories: [excludedDirectory] },
  });

  for (const effect of ["ask", "allow"] as const) {
    const excludedRead = createEvaluation("read", effect, [path.join(excludedDirectory, "secret.txt")]);
    evaluate(excludedRead);
    expect(excludedRead.effect).toBe("deny");
  }

  for (const resource of [defaultDirectory, `${defaultDirectory}/*`]) {
    const broadGate = createEvaluation("external_directory", "allow", [resource]);
    evaluate(broadGate);
    expect(broadGate.effect).toBe("deny");
  }

  const multipleResources = createEvaluation("edit", "ask", [
    path.join(defaultDirectory, "public", "file.txt"),
    path.join(excludedDirectory, "secret.txt"),
  ]);
  evaluate(multipleResources);
  expect(multipleResources.effect).toBe("deny");

  const incomingDeny = createEvaluation("read", "deny", [path.join(excludedDirectory, "secret.txt")]);
  evaluate(incomingDeny);
  expect(incomingDeny.effect).toBe("deny");

  const sibling = createEvaluation("read", "ask", [path.join(defaultDirectory, "private-sibling", "file.txt")]);
  evaluate(sibling);
  expect(sibling.effect).toBe("allow");
});

test("denies a root wildcard gate when it covers an excluded directory", () => {
  const evaluate = createDirectoryPermissionEvaluator({
    permissions: { denyDirectories: ["/private"] },
  }, path.posix);

  for (const effect of ["ask", "allow"] as const) {
    const rootGate = createEvaluation("external_directory", effect, ["/*"]);
    evaluate(rootGate);
    expect(rootGate.effect).toBe("deny");
  }
});

test("leaves unsupported actions and malformed or mixed resources unchanged", () => {
  const excludedDirectory = path.join(defaultDirectory, "private");
  const evaluate = createDirectoryPermissionEvaluator({
    permissions: { denyDirectories: [excludedDirectory] },
  });

  for (const action of ["shell", "bash", "write", "unknown"]) {
    const unsupported = createEvaluation(action, "ask", [path.join(excludedDirectory, "script.sh")]);
    evaluate(unsupported);
    expect(unsupported.effect).toBe("ask");
  }

  for (const resource of [
    "relative/file.txt",
    `${defaultDirectory}/**/file.txt`,
    `${defaultDirectory}/file?.txt`,
    null as unknown as string,
  ]) {
    const malformed = createEvaluation("read", "ask", [resource]);
    evaluate(malformed);
    expect(malformed.effect).toBe("ask");
  }

  const mixedWithOutside = createEvaluation("read", "ask", [
    path.join(defaultDirectory, "public.txt"),
    path.join(os.tmpdir(), "other", "file.txt"),
  ]);
  evaluate(mixedWithOutside);
  expect(mixedWithOutside.effect).toBe("ask");
});

test("uses component-aware Windows drive and UNC matching when a path helper is injected", () => {
  const windowsPath: PathApi = path.win32;
  const driveRoot = "C:\\Users\\Test\\opencode";
  const driveExcluded = `${driveRoot}\\private`;
  const uncRoot = "\\\\server\\share\\opencode";
  const evaluate = createDirectoryPermissionEvaluator({
    permissions: {
      allowDirectories: [driveRoot, uncRoot],
      denyDirectories: [driveExcluded, `${uncRoot}\\secret`],
    },
  }, windowsPath);

  const drivePath = createEvaluation("read", "ask", [`${driveRoot}\\file.txt`]);
  evaluate(drivePath);
  expect(drivePath.effect).toBe("allow");

  const uncPath = createEvaluation("edit", "ask", [`${uncRoot}\\nested\\file.txt`]);
  evaluate(uncPath);
  expect(uncPath.effect).toBe("allow");

  const driveRelative = createEvaluation("read", "ask", ["C:Users\\Test\\opencode\\file.txt"]);
  evaluate(driveRelative);
  expect(driveRelative.effect).toBe("ask");

  const rootRelative = createEvaluation("read", "ask", ["\\Users\\Test\\opencode\\file.txt"]);
  evaluate(rootRelative);
  expect(rootRelative.effect).toBe("ask");

  const windowsPattern = createEvaluation("external_directory", "ask", [`${uncRoot}\\nested\\*`]);
  evaluate(windowsPattern);
  expect(windowsPattern.effect).toBe("allow");

  const driveSibling = createEvaluation("read", "ask", [`${driveRoot}-sibling\\file.txt`]);
  evaluate(driveSibling);
  expect(driveSibling.effect).toBe("ask");

  const uncSibling = createEvaluation("read", "ask", ["\\\\server\\share\\opencode-sibling\\file.txt"]);
  evaluate(uncSibling);
  expect(uncSibling.effect).toBe("ask");

  const excludedUncPath = createEvaluation("read", "ask", [`${uncRoot}\\secret\\file.txt`]);
  evaluate(excludedUncPath);
  expect(excludedUncPath.effect).toBe("deny");

  const broadDriveGate = createEvaluation("external_directory", "allow", [driveRoot]);
  evaluate(broadDriveGate);
  expect(broadDriveGate.effect).toBe("deny");

  for (const effect of ["ask", "allow"] as const) {
    for (const resource of ["C:\\*", "C:/*", "\\\\server\\share\\*"]) {
      const rootGate = createEvaluation("external_directory", effect, [resource]);
      evaluate(rootGate);
      expect(rootGate.effect).toBe("deny");
    }

    for (const resource of [
      `${driveRoot}\\private.\\secret.txt`,
      `${driveRoot}\\private \\secret.txt`,
      `\\\\?\\C:\\Users\\Test\\opencode\\private\\secret.txt`,
    ]) {
      const ambiguous = createEvaluation("read", effect, [resource]);
      evaluate(ambiguous);
      expect(ambiguous.effect).toBe("deny");
    }
  }
});

test("rejects malformed permission configuration instead of silently ignoring it", () => {
  const invalidConfigurations: Array<[unknown, RegExp]> = [
    [null, /plugin options must be an object/],
    [[], /plugin options must be an object/],
    [new Map(), /plugin options must be an object/],
    [{ permissions: null }, /options\.permissions must be an object/],
    [{ permissions: [] }, /options\.permissions must be an object/],
    [{ permissions: { allowDirectories: "\/tmp\/custom" } }, /allowDirectories must be an array/],
    [{ permissions: { denyDirectories: {} } }, /denyDirectories must be an array/],
    [{ permissions: { allowDirectories: ["relative/path"] } }, /must be an absolute path/],
    [{ permissions: { denyDirectories: ["/tmp/private/*"] } }, /must be a literal path without globs/],
    [{ permissions: { allowDirectories: ["/tmp/private\0path"] } }, /must not contain NUL/],
    [{ permissions: { allowDirectories: [null] } }, /must be a string path/],
    [{ permissions: { allowedDirectories: ["/tmp/custom"] } }, /is not supported/],
  ];

  for (const [configuration, message] of invalidConfigurations) {
    expect(() => createDirectoryPermissionEvaluator(configuration)).toThrow(message);
  }

  expect(() => createDirectoryPermissionEvaluator({
    permissions: { allowDirectories: ["\\Users\\Test\\opencode"] },
  }, path.win32)).toThrow(/must be an absolute path/);

  expect(() => createDirectoryPermissionEvaluator({
    permissions: { denyDirectories: ["C:\\work\\private."] },
  }, path.win32)).toThrow(/ambiguous Windows path/);
});
