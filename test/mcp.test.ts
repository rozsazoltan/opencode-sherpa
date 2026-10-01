import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("supports token-file GitHub auth without exposing token on errors", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sherpa-mcp-"));
  const tokenFile = path.join(root, "github-key");
  const token = "fixture-token-not-a-real-credential";
  try {
    expect(() => createRemoteMcpServers({
      githubAuth: "token-file",
      githubTokenFile: path.join(root, "missing-key"),
    }, { github: { type: "local" } })).not.toThrow();
    writeFileSync(tokenFile, `${token}\r\n`);
    expect(createRemoteMcpServers({ githubAuth: "token-file", githubTokenFile: tokenFile }).github)
      .toEqual({
        type: "remote",
        url: "https://api.githubcopilot.com/mcp/",
        oauth: false,
        headers: { Authorization: `Bearer ${token}` },
      });
    writeFileSync(tokenFile, "first-line\nsecond-line\n");
    expect(() => createRemoteMcpServers({ githubAuth: "token-file", githubTokenFile: tokenFile }))
      .toThrow("GitHub token file must contain one line.");
    expect(readFileSync(tokenFile, "utf8")).toContain("second-line");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects invalid MCP options", () => {
  for (const options of [null, [], { githubAuth: "personal-access-token" }, { githubTokenFile: "/tmp/token" }, { other: true }]) {
    expect(() => createRemoteMcpServers(options as never)).toThrow();
  }
});
