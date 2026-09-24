import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { MCPEditor } from "@opencode/plugin/promise/mcp";
import type { Registration } from "@opencode/plugin/promise/registration";
import { registerRemoteMcpServers, type McpOptions } from "../src/mcp.ts";

const registration: Registration = { dispose: async () => {} };

async function captureError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("Expected operation to fail.");
}

function createContext(initial: Record<string, unknown> = {}) {
  const servers = new Map(Object.entries(initial));
  let transformCalls = 0;
  const editor = {
    list: () => [...servers.entries()],
    get: (name: string) => servers.get(name),
    set: (name: string, config: unknown) => { servers.set(name, config); },
    update: () => {},
    remove: (name: string) => { servers.delete(name); },
  } as unknown as MCPEditor;

  const context = {
    mcp: {
      transform: async (callback: (editor: MCPEditor) => void) => {
        transformCalls++;
        callback(editor);
        return registration;
      },
    },
  } as unknown as Pick<Context, "mcp">;

  return { context, servers, get transformCalls() { return transformCalls; } };
}

test("registers remote servers with host-managed GitHub OAuth by default", async () => {
  const { context, servers } = createContext();

  const result = await registerRemoteMcpServers(context);

  expect(result).toBe(registration);
  expect(servers.get("github")).toEqual({
    type: "remote",
    url: "https://api.githubcopilot.com/mcp/",
  });
  expect(servers.get("jina")).toEqual({
    type: "remote",
    url: "https://mcp.jina.ai/v1",
  });
});

test("does not replace pre-existing MCP server configurations", async () => {
  const github = { type: "remote", url: "https://github.example/mcp" };
  const jina = { type: "local", command: ["existing-jina"] };
  const { context, servers } = createContext({ github, jina });

  await registerRemoteMcpServers(context);

  expect(servers.get("github")).toBe(github);
  expect(servers.get("jina")).toBe(jina);
});

test("does not read a missing token file when GitHub already exists", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sherpa-mcp-"));
  const missingTokenFile = path.join(directory, "missing-github-key");
  const github = { type: "remote", url: "https://github.example/mcp" };
  const fixture = createContext({ github });

  try {
    await registerRemoteMcpServers(fixture.context, {
      githubAuth: "token-file",
      githubTokenFile: missingTokenFile,
    });

    expect(fixture.servers.get("github")).toBe(github);
    expect(fixture.servers.get("jina")).toEqual({
      type: "remote",
      url: "https://mcp.jina.ai/v1",
    });
    expect(fixture.transformCalls).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("uses an explicit token file and strips trailing newlines", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sherpa-mcp-"));
  const tokenFile = path.join(directory, "github-key");
  const token = "fake-test-token-not-a-real-credential";
  try {
    await writeFile(tokenFile, `${token}\r\n`, "utf8");
    const { context, servers } = createContext();

    await registerRemoteMcpServers(context, {
      githubAuth: "token-file",
      githubTokenFile: tokenFile,
    });

    expect(servers.get("github")).toEqual({
      type: "remote",
      url: "https://api.githubcopilot.com/mcp/",
      oauth: false,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(await readFile(tokenFile, "utf8")).toBe(`${token}\r\n`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reports missing and empty token files without exposing file paths or contents", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sherpa-mcp-"));
  const secretMarker = "fake-token-path-must-not-leak";
  const missingFile = path.join(directory, secretMarker);
  const emptyFile = path.join(directory, "empty-key");
  try {
    await writeFile(emptyFile, " \n", "utf8");

    const missing = await captureError(registerRemoteMcpServers(createContext().context, {
      githubAuth: "token-file",
      githubTokenFile: missingFile,
    }));
    expect(missing).toBeInstanceOf(Error);
    expect(missing.message).toBe("Unable to read GitHub token file.");
    expect(missing.message).not.toContain(secretMarker);

    const empty = await captureError(registerRemoteMcpServers(createContext().context, {
      githubAuth: "token-file",
      githubTokenFile: emptyFile,
    }));
    expect(empty).toBeInstanceOf(Error);
    expect(empty.message).toBe("GitHub token file is empty.");
    expect(empty.message).not.toContain(secretMarker);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects multiline token files without exposing the token", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sherpa-mcp-"));
  const tokenFile = path.join(directory, "github-key");
  try {
    await writeFile(tokenFile, "fake-secret-first-line\r\nsecond-line\n");
    const error = await captureError(registerRemoteMcpServers(createContext().context, {
      githubAuth: "token-file",
      githubTokenFile: tokenFile,
    }));
    expect(error.message).toBe("GitHub token file must contain one line.");
    expect(error.message).not.toContain("fake-secret-first-line");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects malformed MCP options before registering servers", async () => {
  const cases: unknown[] = [
    null,
    [],
    { githubAuth: "personal-access-token" },
    { githubAuth: "token-file", githubTokenFile: "relative/key" },
    { githubTokenFile: "/tmp/github-key" },
    { unknown: true },
  ];

  for (const options of cases) {
    const fixture = createContext();
    await expect(
      registerRemoteMcpServers(fixture.context, options as McpOptions),
    ).rejects.toThrow();
    expect(fixture.transformCalls).toBe(0);
  }
});
