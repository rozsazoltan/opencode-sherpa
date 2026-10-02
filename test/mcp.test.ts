import { expect, spyOn, test } from "bun:test";
import fs, { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRemoteMcpServers } from "../src/mcp.ts";

test("builds default project MCP entries", () => {
  expect(createRemoteMcpServers()).toEqual({
    github: { type: "remote", url: "https://api.githubcopilot.com/mcp/" },
    jina: { type: "remote", url: "https://mcp.jina.ai/v1" },
    context7: { type: "remote", url: "https://mcp.context7.com/mcp" },
    gh_grep: { type: "remote", url: "https://mcp.grep.app" },
  });
});

test("uses OpenCode file references for explicit GitHub token-file auth", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sherpa-mcp-"));
  const tokenFile = path.join(root, "github-key");
  const sentinel = "fixture-sentinel-not-a-credential";
  const fileContents = Buffer.from(`${sentinel}\nsecond-line\n\u0000\xff`, "binary");
  try {
    writeFileSync(tokenFile, fileContents);
    const read = spyOn(fs, "readFileSync");
    const stat = spyOn(fs, "statSync");
    const open = spyOn(fs, "openSync");
    try {
      const servers = createRemoteMcpServers(
        { githubAuth: "token-file", githubTokenFile: tokenFile },
        {},
        { globalConfigDirectory: root },
      );
      expect(servers.github).toEqual({
        type: "remote",
        url: "https://api.githubcopilot.com/mcp/",
        oauth: false,
        headers: { Authorization: `Bearer {file:${tokenFile}}` },
      });
      expect(JSON.stringify(servers)).not.toContain(sentinel);
      expect(read).not.toHaveBeenCalled();
      expect(stat).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
      stat.mockRestore();
      open.mockRestore();
    }

    const missingFile = path.join(root, "missing-key");
    expect(createRemoteMcpServers({ githubAuth: "token-file", githubTokenFile: missingFile }).github)
      .toEqual({
        type: "remote",
        url: "https://api.githubcopilot.com/mcp/",
        oauth: false,
        headers: { Authorization: `Bearer {file:${missingFile}}` },
      });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("uses default GitHub secret path under supplied global config directory", () => {
  const globalConfigDirectory = path.resolve("fixture-global-config");
  expect(createRemoteMcpServers({ githubAuth: "token-file" }, {}, { globalConfigDirectory }).github)
    .toEqual({
      type: "remote",
      url: "https://api.githubcopilot.com/mcp/",
      oauth: false,
      headers: {
        Authorization: `Bearer {file:${path.join(globalConfigDirectory, ".secrets", "github-key")}}`,
      },
    });
});

test("does not build GitHub file auth when global GitHub server already exists", () => {
  const existing = { type: "remote", url: "https://example.test/mcp" };
  expect(createRemoteMcpServers(
    { githubAuth: "token-file", githubTokenFile: "/fixture/missing-key" },
    { github: existing },
  ).github).toEqual({ type: "remote", url: "https://api.githubcopilot.com/mcp/" });
});

test("rejects invalid MCP options", () => {
  for (const options of [
    null,
    [],
    { githubAuth: "personal-access-token" },
    { githubTokenFile: "/tmp/token" },
    { githubAuth: "token-file", githubTokenFile: "relative/token" },
    { githubAuth: "token-file", githubTokenFile: "/tmp/unsafe{file}" },
    { githubAuth: "token-file", githubTokenFile: "/tmp/unsafe\nheader" },
    { other: true },
  ]) {
    expect(() => createRemoteMcpServers(options as never)).toThrow();
  }

  for (const runtimeOptions of [
    null,
    [],
    { globalConfigDirectory: "relative/config" },
    { globalConfigDirectory: "/tmp/unsafe{directory}" },
    { globalConfigDirectory: "/tmp/unsafe\ndirectory" },
    { unknown: true },
  ]) {
    expect(() => createRemoteMcpServers(undefined, {}, runtimeOptions as never)).toThrow();
  }
});
