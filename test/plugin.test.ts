import { expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { PermissionEvaluation } from "@opencode/plugin/promise/permission";
import type { SessionContext } from "@opencode/plugin/promise/session";
import type { Registration } from "@opencode/plugin/promise/registration";
import SherpaPlugin from "../src/index.ts";

type PermissionDecision = Pick<PermissionEvaluation, "action" | "effect" | "resources">;

test("registers context and permission hooks and disposes both", async () => {
  const disposed: string[] = [];
  const defaultDirectory = path.join(os.tmpdir(), "opencode");
  const extraDirectory = path.join(os.tmpdir(), "sherpa-plugin-extra");
  const excludedDirectory = path.join(defaultDirectory, "private");
  let contextCallback: ((input: SessionContext) => void | Promise<void>) | undefined;
  let permissionCallback: ((input: PermissionDecision) => void | Promise<void>) | undefined;

  const sessionHook = async (
    name: "context",
    callback: (input: SessionContext) => void | Promise<void>,
  ): Promise<Registration> => {
    expect(name).toBe("context");
    contextCallback = callback;
    return { dispose: async () => { disposed.push(`session.${name}`); } };
  };

  const permissionHook = async (
    name: "evaluate",
    callback: (input: PermissionDecision) => void | Promise<void>,
  ): Promise<Registration> => {
    expect(name).toBe("evaluate");
    permissionCallback = callback;
    return { dispose: async () => { disposed.push(`permission.${name}`); } };
  };

  const context = {
    options: {
      language: "hu",
      permissions: {
        allowDirectories: [extraDirectory],
        denyDirectories: [excludedDirectory],
      },
    },
    session: { hook: sessionHook },
    permission: { hook: permissionHook },
  } as unknown as Context;
  const cleanup = await SherpaPlugin.setup(context);

  expect(contextCallback).toBeDefined();
  expect(permissionCallback).toBeDefined();

  const sessionContext = { system: [] } as unknown as SessionContext;
  await contextCallback?.(sessionContext);
  expect(sessionContext.system).toHaveLength(1);
  const systemMessage = sessionContext.system[0];
  expect(systemMessage?.type).toBe("text");
  if (systemMessage?.type === "text") {
    expect(systemMessage.text).toMatch(/Use hu for conversation/);
  }

  for (const action of ["external_directory", "read", "edit"]) {
    const permission: PermissionDecision = {
      action,
      effect: "ask",
      resources: [path.join(defaultDirectory, "uploads", "file.txt")],
    };
    await permissionCallback?.(permission);
    expect(permission.effect).toBe("allow");
  }

  const extraDirectoryPermission: PermissionDecision = {
    action: "edit",
    effect: "ask",
    resources: [path.join(extraDirectory, "file.txt")],
  };
  await permissionCallback?.(extraDirectoryPermission);
  expect(extraDirectoryPermission.effect).toBe("allow");

  const excludedPermission: PermissionDecision = {
    action: "read",
    effect: "allow",
    resources: [path.join(excludedDirectory, "secret.txt")],
  };
  await permissionCallback?.(excludedPermission);
  expect(excludedPermission.effect).toBe("deny");

  const broadDirectoryGate: PermissionDecision = {
    action: "external_directory",
    effect: "ask",
    resources: [defaultDirectory],
  };
  await permissionCallback?.(broadDirectoryGate);
  expect(broadDirectoryGate.effect).toBe("deny");

  const deniedShellPermission: PermissionDecision = {
    action: "shell",
    effect: "ask",
    resources: [path.join(excludedDirectory, "script.sh")],
  };
  await permissionCallback?.(deniedShellPermission);
  expect(deniedShellPermission.effect).toBe("ask");

  const mixedPermission: PermissionDecision = {
    action: "read",
    effect: "ask",
    resources: [
      path.join(defaultDirectory, "public.txt"),
      path.join(os.tmpdir(), "outside", "file.txt"),
    ],
  };
  await permissionCallback?.(mixedPermission);
  expect(mixedPermission.effect).toBe("ask");

  await cleanup?.();
  expect(disposed.sort()).toEqual(["permission.evaluate", "session.context"]);
});
