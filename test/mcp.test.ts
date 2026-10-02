import { expect, spyOn, test } from "bun:test";
import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRemoteMcpServers } from "../src/mcp.ts";
import { DEFAULT_SHERPA_MCP_CATALOG } from "../src/mcp-catalog.ts";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "sherpa-mcp-"));
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

function createServers(globalConfigDirectory: string, existingServers: Record<string, unknown> = {}) {
  return createRemoteMcpServers(existingServers, { globalConfigDirectory });
}

test("builds default project MCP entries without credentials when key files are absent", () => {
  const { root, dispose } = fixture();
  try {
    expect(createServers(root)).toEqual({
      github: { type: "remote", url: "https://api.githubcopilot.com/mcp/" },
      jina: { type: "remote", url: "https://mcp.jina.ai/v1" },
      context7: { type: "remote", url: "https://mcp.context7.com/mcp" },
      gh_grep: { type: "remote", url: "https://mcp.grep.app" },
    });
  } finally {
    dispose();
  }
});

test("uses each existing global key file as a file reference without reading it", () => {
  const { root, dispose } = fixture();
  const secretsDirectory = path.join(root, ".secrets");
  const sentinel = "fixture-sentinel-not-a-credential";
  mkdirSync(secretsDirectory);
  for (const { id } of DEFAULT_SHERPA_MCP_CATALOG) {
    writeFileSync(path.join(secretsDirectory, `${id}-key`), Buffer.from(`${sentinel}\n\0\xff`, "binary"));
  }

  const read = spyOn(fs, "readFileSync");
  const open = spyOn(fs, "openSync");
  try {
    const servers = createServers(root);
    for (const { id, url } of DEFAULT_SHERPA_MCP_CATALOG) {
      const keyPath = path.join(secretsDirectory, `${id}-key`);
      expect(servers[id]).toEqual({
        type: "remote",
        url,
        oauth: false,
        headers: { Authorization: `Bearer {file:${keyPath}}` },
      });
    }
    expect(JSON.stringify(servers)).not.toContain(sentinel);
    expect(read).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
    open.mockRestore();
    dispose();
  }
});

test("keeps missing and non-file credentials out of MCP headers", () => {
  const { root, dispose } = fixture();
  try {
    mkdirSync(path.join(root, ".secrets"));
    mkdirSync(path.join(root, ".secrets", "github-key"));
    expect(createServers(root).github).toEqual({
      type: "remote",
      url: "https://api.githubcopilot.com/mcp/",
    });
  } finally {
    dispose();
  }
});

test("does not inspect credentials for servers already configured", () => {
  const { root, dispose } = fixture();
  const secretsDirectory = path.join(root, ".secrets");
  mkdirSync(secretsDirectory);
  for (const { id } of DEFAULT_SHERPA_MCP_CATALOG) {
    writeFileSync(path.join(secretsDirectory, `${id}-key`), "fixture secret\n");
  }
  const stat = spyOn(fs, "statSync");
  try {
    const existingServers = Object.fromEntries(DEFAULT_SHERPA_MCP_CATALOG.map(({ id }) => [id, false]));
    const servers = createServers(root, existingServers);
    for (const { id, url } of DEFAULT_SHERPA_MCP_CATALOG) {
      expect(servers[id]).toEqual({ type: "remote", url });
    }
    expect(stat).not.toHaveBeenCalled();
  } finally {
    stat.mockRestore();
    dispose();
  }
});

test("rejects invalid MCP runtime options", () => {
  const { root, dispose } = fixture();
  try {
    for (const runtimeOptions of [
      null,
      [],
      { globalConfigDirectory: "relative/config" },
      { globalConfigDirectory: "/tmp/unsafe{directory}" },
      { globalConfigDirectory: "/tmp/unsafe\ndirectory" },
      { unknown: true },
    ]) {
      expect(() => createRemoteMcpServers({}, runtimeOptions as never)).toThrow();
    }
  } finally {
    dispose();
  }
});
