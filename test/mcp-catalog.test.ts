import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_SHERPA_MCP_CATALOG } from "../src/mcp-catalog.ts";
import { createRemoteMcpServers } from "../src/mcp.ts";

test("default MCP catalog has unique IDs and current credential-free URLs", () => {
  const ids = DEFAULT_SHERPA_MCP_CATALOG.map(({ id }) => id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(DEFAULT_SHERPA_MCP_CATALOG).toEqual([
    { id: "github", url: "https://api.githubcopilot.com/mcp/" },
    { id: "jina", url: "https://mcp.jina.ai/v1" },
    { id: "context7", url: "https://mcp.context7.com/mcp" },
    { id: "gh_grep", url: "https://mcp.grep.app" },
  ]);

  for (const { url } of DEFAULT_SHERPA_MCP_CATALOG) {
    const parsedUrl = new URL(url);
    expect(parsedUrl.protocol).toBe("https:");
    expect(parsedUrl.username).toBe("");
    expect(parsedUrl.password).toBe("");
    expect(parsedUrl.search).toBe("");
    expect(parsedUrl.hash).toBe("");
  }
});

test("remote MCP servers are constructed deterministically from catalog order", () => {
  const expected = Object.fromEntries(DEFAULT_SHERPA_MCP_CATALOG.map(({ id, url }) => [
    id,
    { type: "remote", url },
  ]));

  const globalConfigDirectory = mkdtempSync(path.join(os.tmpdir(), "sherpa-mcp-catalog-"));
  try {
    const first = createRemoteMcpServers(undefined, {}, { globalConfigDirectory });
    const second = createRemoteMcpServers(undefined, {}, { globalConfigDirectory });
    expect(first).toEqual(expected);
    expect(second).toEqual(expected);
    expect(Object.keys(first)).toEqual(DEFAULT_SHERPA_MCP_CATALOG.map(({ id }) => id));
  } finally {
    rmSync(globalConfigDirectory, { recursive: true, force: true });
  }
});
