import { expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import * as tar from "tar";
import { resolveSherpaAgentSources } from "../src/agent-sources.ts";
import { createSourcePathNamespace, resolvePinnedSource } from "../src/source-cache.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

test("source path namespace accepts file-like paths and rejects case-folded aliases", () => {
  const namespace = createSourcePathNamespace();
  namespace.add("skills/CLAUDE.md", "file");
  expect(() => namespace.add("Skills/AGENTS.md", "file")).toThrow("Case-insensitive source path collision");

  const prefixConflict = createSourcePathNamespace();
  prefixConflict.add("Docs", "file");
  expect(() => prefixConflict.add("docs/reference.md", "file")).toThrow("Case-insensitive source path collision");

  const repeatedDirectories = createSourcePathNamespace();
  repeatedDirectories.add("references", "directory");
  repeatedDirectories.add("references", "directory");
  repeatedDirectories.add("references/A.txt", "file");
  expect(() => repeatedDirectories.add("References/B.txt", "file")).toThrow("Case-insensitive source path collision");
});

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "sherpa-source-cache-test-"));
  const write = (relative: string, contents: string) => {
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
    return target;
  };
  const link = (relative: string, target: string) => {
    const location = path.join(root, relative);
    mkdirSync(path.dirname(location), { recursive: true });
    symlinkSync(target, location);
    return location;
  };
  return { root, write, link, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

async function archive(root: string, entries: string[] = ["payload"], name = "archive.tgz"): Promise<Buffer> {
  const target = path.join(root, name);
  await tar.c({ cwd: path.join(root, "repository"), file: target, gzip: true, prefix: `repo-${COMMIT}` }, entries);
  return readFileSync(target);
}

function rawArchive(entries: { path: string; type: string; target?: string; data?: string }[]): Buffer {
  const records: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? "");
    const header = Buffer.alloc(512);
    header.write(entry.path, 0, 100, "utf8");
    header.write("0000644\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii");
    header.fill(0x20, 148, 156);
    header.write(entry.type, 156, 1, "ascii");
    if (entry.target) header.write(entry.target, 157, 100, "utf8");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    records.push(header);
    if (data.length) {
      records.push(data);
      const padding = (512 - (data.length % 512)) % 512;
      if (padding) records.push(Buffer.alloc(padding));
    }
  }
  records.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(records));
}

test("pinned source cache shares canonical repository/commit identity and verifies immutable files", async () => {
  const root = fixture();
  try {
    root.write("repository/payload/data.bin", "original bytes\0\u00ff");
    const bytes = await archive(root.root);
    let fetches = 0;
    const fetchImpl = (async () => {
      fetches++;
      return new Response(bytes, { status: 200 });
    }) as unknown as typeof fetch;
    const options = { cacheDirectory: path.join(root.root, "cache"), fetchImpl };
    const first = await resolvePinnedSource({ repository: "Example/Shared", commit: COMMIT }, options);
    expect(first.cacheHit).toBe(false);
    expect(first.marker.repository).toBe("example/shared");
    expect(first.marker.files["payload/data.bin"]).toBe(createHash("sha256").update("original bytes\0\u00ff").digest("hex"));

    const second = await resolvePinnedSource({ repository: "example/shared", commit: COMMIT }, {
      ...options,
      fetchImpl: (async () => { throw new Error("Cache must be reused."); }) as unknown as typeof fetch,
    });
    expect(second.cacheHit).toBe(true);
    expect(fetches).toBe(1);

    writeFileSync(path.join(first.root, "payload", "data.bin"), "tampered");
    await expect(resolvePinnedSource({ repository: "example/shared", commit: COMMIT }, options))
      .rejects.toThrow("Agent source cache integrity check failed");
  } finally {
    root.dispose();
  }
});

test("pinned source cache rejects unsafe descriptors before fetching", async () => {
  let fetches = 0;
  const fetchImpl = (async () => {
    fetches++;
    throw new Error("Must not fetch.");
  }) as unknown as typeof fetch;
  const root = fixture();
  try {
    await expect(resolvePinnedSource({ repository: "https://github.com.evil.test/owner/repo", commit: COMMIT }, {
      cacheDirectory: path.join(root.root, "cache"), fetchImpl,
    })).rejects.toThrow("Only owner/repository and HTTPS github.com URLs are supported");
    expect(fetches).toBe(0);
  } finally {
    root.dispose();
  }
});

test("strict pinned source resolution rejects archive symlinks", async () => {
  const root = fixture();
  try {
    root.write("repository/payload/target", "safe target\n");
    symlinkSync("target", path.join(root.root, "repository/payload/escape"));
    const bytes = await archive(root.root);
    await expect(resolvePinnedSource({ repository: "owner/unsafe", commit: COMMIT }, {
      cacheDirectory: path.join(root.root, "cache"),
      fetchImpl: (async () => new Response(bytes, { status: 200 })) as unknown as typeof fetch,
    })).rejects.toThrow("Source archive contains symlink");
  } finally {
    root.dispose();
  }
});

test("selection-aware cache omits safe aliases and strict callers reject cold and warm caches", async () => {
  const root = fixture();
  try {
    root.write("repository/payload/selected.txt", "selected bytes\n");
    root.write("repository/payload/target.txt", "alias target bytes\n");
    root.link("repository/payload/alias.txt", "target.txt");
    const bytes = await archive(root.root, ["payload/selected.txt", "payload/target.txt", "payload/alias.txt"]);
    const cacheDirectory = path.join(root.root, "cache");
    const source = { repository: "owner/alias-fixture", commit: COMMIT };
    const fetchImpl = (async () => new Response(bytes, { status: 200 })) as unknown as typeof fetch;

    await expect(resolvePinnedSource(source, { cacheDirectory, fetchImpl }))
      .rejects.toThrow("Source archive contains symlink");
    const selected = await resolvePinnedSource(source, { cacheDirectory, fetchImpl }, {
      files: ["payload/selected.txt"], trees: [],
    });
    expect(selected.cacheHit).toBe(false);
    expect(selected.marker.files["payload/selected.txt"]).toBeDefined();
    expect(selected.marker.files["payload/target.txt"]).toBeDefined();
    expect(selected.marker.skippedSymlinks).toEqual({ "payload/alias.txt": "target.txt" });
    expect(existsSync(path.join(selected.root, "payload", "alias.txt"))).toBe(false);

    const warmSelection = await resolvePinnedSource(source, {
      cacheDirectory,
      fetchImpl: (async () => { throw new Error("Warm cache must avoid fetching."); }) as unknown as typeof fetch,
    }, { files: ["payload/selected.txt"], trees: [] });
    expect(warmSelection.cacheHit).toBe(true);
    await expect(resolvePinnedSource(source, {
      cacheDirectory,
      fetchImpl: (async () => { throw new Error("Strict warm cache must not fetch."); }) as unknown as typeof fetch,
    })).rejects.toThrow("Source archive contains symlink");
    await expect(resolvePinnedSource(source, {
      cacheDirectory,
      fetchImpl: (async () => { throw new Error("Selected warm cache must not fetch."); }) as unknown as typeof fetch,
    }, { files: ["payload/alias.txt"], trees: [] })).rejects.toThrow("affects selected skill path");
  } finally {
    root.dispose();
  }
});

test("agent source resolution remains strict on cold archives and selection-aware warm caches", async () => {
  const root = fixture();
  try {
    root.write("repository/LICENSE", "MIT\n");
    root.write("repository/prompts/agent.md", "---\ndescription: Agent.\n---\nPrompt.\n");
    root.link("repository/AGENTS.md", "LICENSE");
    const bytes = await archive(root.root, ["LICENSE", "prompts", "AGENTS.md"]);
    const cacheDirectory = path.join(root.root, "cache");
    const source = [{
      namespace: "strict-agent",
      repository: "owner/strict-agent",
      commit: COMMIT,
      directories: ["prompts"],
    }];
    const cold = await resolveSherpaAgentSources(source, {
      cacheDirectory,
      fetchImpl: (async () => new Response(bytes, { status: 200 })) as unknown as typeof fetch,
    });
    expect(cold.diagnostics[0]?.code).toBe("source-unavailable");
    expect(cold.diagnostics[0]?.message).toContain("Source archive contains symlink");

    await resolvePinnedSource({ repository: "owner/strict-agent", commit: COMMIT }, {
      cacheDirectory,
      fetchImpl: (async () => new Response(bytes, { status: 200 })) as unknown as typeof fetch,
    }, { files: ["LICENSE", "prompts/agent.md"], trees: ["prompts"] });
    const warm = await resolveSherpaAgentSources(source, {
      cacheDirectory,
      fetchImpl: (async () => { throw new Error("Strict warm agent cache must not fetch."); }) as unknown as typeof fetch,
    });
    expect(warm.diagnostics[0]?.code).toBe("source-unavailable");
    expect(warm.diagnostics[0]?.message).toContain("Source archive contains symlink");
  } finally {
    root.dispose();
  }
});

test("selection-aware resolution rejects aliases at selected skill, support, ancestor, and license paths", async () => {
  const protectedPaths = [
    { alias: "skills/demo/SKILL.md", files: ["skills/demo/SKILL.md"], trees: [] },
    { alias: "skills/demo/references", files: [], trees: ["skills/demo/references"] },
    { alias: "skills/demo/references/guide.md", files: [], trees: ["skills/demo/references"] },
    { alias: "skills/demo", files: ["skills/demo/SKILL.md"], trees: [] },
    { alias: "LICENSE", files: ["LICENSE"], trees: [] },
  ];
  const root = fixture();
  try {
    for (const [index, item] of protectedPaths.entries()) {
      root.link(`repository/${item.alias}`, "outside.txt");
      const bytes = await archive(root.root, [item.alias], `selected-${index}.tgz`);
      await expect(resolvePinnedSource({ repository: `owner/selected-${index}`, commit: COMMIT }, {
        cacheDirectory: path.join(root.root, `selected-cache-${index}`),
        fetchImpl: (async () => new Response(bytes, { status: 200 })) as unknown as typeof fetch,
      }, { files: item.files, trees: item.trees })).rejects.toThrow("affects selected skill path");
      rmSync(path.join(root.root, "repository/skills"), { recursive: true, force: true });
      rmSync(path.join(root.root, `repository/${item.alias}`), { force: true });
    }
  } finally {
    root.dispose();
  }
});

test("pinned source cache rejects case-folded archive path collisions before publishing cache", async () => {
  const cases = [
    ["payload/SKILL.md", "payload/skill.md"],
    ["payload/references/A.txt", "payload/references/a.txt"],
    ["payload/references/A.txt", "payload/References/b.txt"],
    ["payload/Docs", "payload/docs/reference.md"],
  ];
  const root = fixture();
  try {
    for (const [index, entries] of cases.entries()) {
      for (const [entryIndex, entry] of entries.entries()) {
        root.write(`repository/${entry}`, `entry-${entryIndex}\n`);
      }
      const bytes = await archive(root.root, entries, `collision-${index}.tgz`);
      const cacheDirectory = path.join(root.root, `cache-${index}`);
      mkdirSync(cacheDirectory);
      writeFileSync(path.join(cacheDirectory, "keep"), "unchanged\n");
      await expect(resolvePinnedSource({ repository: `owner/collision-${index}`, commit: COMMIT }, {
        cacheDirectory,
        fetchImpl: (async () => new Response(bytes, { status: 200 })) as unknown as typeof fetch,
      })).rejects.toThrow(/Case-insensitive source path collision|Source file conflicts with directory path/);
      expect(readdirSync(cacheDirectory)).toEqual(["keep"]);
      expect(readFileSync(path.join(cacheDirectory, "keep"), "utf8")).toBe("unchanged\n");
    }
  } finally {
    root.dispose();
  }
});

test("archive symlink paths and targets validate before selection-based omission", async () => {
  const root = fixture();
  try {
    const invalidTargets = ["../escape", "/absolute", "C:/drive", "one//two", "./dot", "one\\two"];
    for (const [index, target] of invalidTargets.entries()) {
      root.link("repository/payload/alias", target);
      const bytes = await archive(root.root, ["payload/alias"], `unsafe-target-${index}.tgz`);
      await expect(resolvePinnedSource({ repository: `owner/unsafe-target-${index}`, commit: COMMIT }, {
        cacheDirectory: path.join(root.root, `unsafe-target-cache-${index}`),
        fetchImpl: (async () => new Response(bytes, { status: 200 })) as unknown as typeof fetch,
      }, { files: ["selected.txt"], trees: [] })).rejects.toThrow("Unsafe source archive symlink target");
      rmSync(path.join(root.root, "repository/payload/alias"), { force: true });
    }

    const badPath = rawArchive([{ path: `repo-${COMMIT}/payload/../alias`, type: "2", target: "target" }]);
    await expect(resolvePinnedSource({ repository: "owner/unsafe-path", commit: COMMIT }, {
      cacheDirectory: path.join(root.root, "unsafe-path-cache"),
      fetchImpl: (async () => new Response(badPath, { status: 200 })) as unknown as typeof fetch,
    }, { files: ["selected.txt"], trees: [] })).rejects.toThrow("Unsafe source archive path");
  } finally {
    root.dispose();
  }
});

test("hard links and special archive entries remain rejected", async () => {
  const root = fixture();
  try {
    for (const [index, type] of ["1", "3"].entries()) {
      const bytes = rawArchive([{
        path: `repo-${COMMIT}/payload/item`,
        type,
        ...(type === "1" ? { target: "target" } : {}),
      }]);
      await expect(resolvePinnedSource({ repository: `owner/unsupported-${index}`, commit: COMMIT }, {
        cacheDirectory: path.join(root.root, `unsupported-cache-${index}`),
        fetchImpl: (async () => new Response(bytes, { status: 200 })) as unknown as typeof fetch,
      }, { files: ["selected.txt"], trees: [] })).rejects.toThrow("Unsupported source archive entry type");
    }
  } finally {
    root.dispose();
  }
});

test("omitted symlink paths conflict with files and directories in either archive order", async () => {
  const root = fixture();
  const cases = [
    [
      { path: `repo-${COMMIT}/payload/alias`, type: "2", target: "target" },
      { path: `repo-${COMMIT}/payload/alias`, type: "0", data: "regular" },
    ],
    [
      { path: `repo-${COMMIT}/payload/Docs`, type: "2", target: "target" },
      { path: `repo-${COMMIT}/payload/docs`, type: "0", data: "regular" },
    ],
    [
      { path: `repo-${COMMIT}/payload/Docs`, type: "2", target: "target" },
      { path: `repo-${COMMIT}/payload/docs/reference.md`, type: "0", data: "regular" },
    ],
  ];
  try {
    for (const [index, entries] of cases.entries()) {
      for (const order of [entries, [...entries].reverse()]) {
        const bytes = rawArchive(order);
        const repository = `owner/namespace-${index}-${order === entries ? "first" : "last"}`;
        await expect(resolvePinnedSource({ repository, commit: COMMIT }, {
          cacheDirectory: path.join(root.root, repository.replaceAll("/", "-")),
          fetchImpl: (async () => new Response(bytes, { status: 200 })) as unknown as typeof fetch,
        }, { files: ["selected.txt"], trees: [] })).rejects.toThrow(/Case-insensitive source path collision|conflicts with directory|Duplicate or conflicting/);
      }
    }
  } finally {
    root.dispose();
  }
});

test("skipped symlink count and metadata byte budgets are bounded", async () => {
  const root = fixture();
  try {
    for (let index = 0; index < 1_025; index++) {
      root.link(`repository/payload/alias-${index}.txt`, "target");
    }
    const countArchive = await archive(root.root, Array.from({ length: 1_025 }, (_, index) => `payload/alias-${index}.txt`), "count.tgz");
    await expect(resolvePinnedSource({ repository: "owner/symlink-count", commit: COMMIT }, {
      cacheDirectory: path.join(root.root, "count-cache"),
      fetchImpl: (async () => new Response(countArchive, { status: 200 })) as unknown as typeof fetch,
    }, { files: ["selected.txt"], trees: [] })).rejects.toThrow("skipped symlink limits");

    const byteRoot = fixture();
    try {
      const links = Array.from({ length: 70 }, (_, index) => `payload/alias-${index}.txt`);
      for (const link of links) {
        const target = randomBytes(3_000).toString("base64").slice(0, 4_000).replace(/[+/=]/gu, "x");
        byteRoot.link(`repository/${link}`, target);
      }
      const byteArchive = await archive(byteRoot.root, links, "bytes.tgz");
      await expect(resolvePinnedSource({ repository: "owner/symlink-bytes", commit: COMMIT }, {
        cacheDirectory: path.join(byteRoot.root, "cache"),
        fetchImpl: (async () => new Response(byteArchive, { status: 200 })) as unknown as typeof fetch,
      }, { files: ["selected.txt"], trees: [] })).rejects.toThrow("skipped symlink limits");
    } finally {
      byteRoot.dispose();
    }
  } finally {
    root.dispose();
  }
});

test("cache validates skipped-symlink marker, state, namespace, and physical absence", async () => {
  const root = fixture();
  try {
    root.write("repository/payload/selected.txt", "selected\n");
    root.write("repository/payload/target.txt", "target\n");
    root.link("repository/payload/alias.txt", "target.txt");
    const bytes = await archive(root.root, ["payload/selected.txt", "payload/target.txt", "payload/alias.txt"]);
    const cacheDirectory = path.join(root.root, "cache");
    const source = { repository: "owner/tampered-symlink-map", commit: COMMIT };
    const fetchImpl = (async () => new Response(bytes, { status: 200 })) as unknown as typeof fetch;
    const selection = { files: ["payload/selected.txt"], trees: [] };
    const cached = await resolvePinnedSource(source, { cacheDirectory, fetchImpl }, selection);
    const markerPath = path.join(cached.root, ".sherpa-source-cache.json");
    const statePath = path.join(cacheDirectory, "state.json");
    const originalMarker = readFileSync(markerPath, "utf8");
    const originalState = readFileSync(statePath, "utf8");

    const malformedMarker = JSON.parse(originalMarker) as Record<string, unknown>;
    malformedMarker.skippedSymlinks = { "payload/alias.txt": "../escape" };
    writeFileSync(markerPath, `${JSON.stringify(malformedMarker)}\n`);
    await expect(resolvePinnedSource(source, { cacheDirectory, fetchImpl }, selection))
      .rejects.toThrow("Agent source cache identity mismatch");

    writeFileSync(markerPath, originalMarker);
    const disagreeingState = JSON.parse(originalState) as { sources: Record<string, Record<string, unknown>> };
    const stateEntry = Object.values(disagreeingState.sources)[0]!;
    stateEntry.skippedSymlinks = { "payload/other.txt": "target.txt" };
    writeFileSync(statePath, `${JSON.stringify(disagreeingState)}\n`);
    await expect(resolvePinnedSource(source, { cacheDirectory, fetchImpl }, selection))
      .rejects.toThrow("Agent source cache state does not match immutable cache");

    writeFileSync(statePath, originalState);
    mkdirSync(path.join(cached.root, "payload", "alias.txt"));
    await expect(resolvePinnedSource(source, { cacheDirectory, fetchImpl }, selection))
      .rejects.toThrow("omitted symlink path exists");
    rmSync(path.join(cached.root, "payload", "alias.txt"), { recursive: true, force: true });
    symlinkSync("target.txt", path.join(cached.root, "payload", "alias.txt"));
    await expect(resolvePinnedSource(source, { cacheDirectory, fetchImpl }, selection))
      .rejects.toThrow("Source archive contains symlink");
  } finally {
    root.dispose();
  }
});

test("warm cache rejects case-folded physical directories at omitted symlink paths", async () => {
  const root = fixture();
  try {
    root.write("repository/payload/selected.txt", "selected\n");
    root.write("repository/payload/target.txt", "target\n");
    root.link("repository/payload/alias.txt", "target.txt");
    const bytes = await archive(root.root, ["payload/selected.txt", "payload/target.txt", "payload/alias.txt"]);
    const source = { repository: "owner/physical-directory-alias", commit: COMMIT };
    const cacheDirectory = path.join(root.root, "cache");
    const selection = { files: ["payload/selected.txt"], trees: [] };
    const cached = await resolvePinnedSource(source, {
      cacheDirectory,
      fetchImpl: (async () => new Response(bytes, { status: 200 })) as unknown as typeof fetch,
    }, selection);

    mkdirSync(path.join(cached.root, "payload", "ALIAS.TXT"));
    await expect(resolvePinnedSource(source, {
      cacheDirectory,
      fetchImpl: (async () => { throw new Error("Invalid warm cache must not fetch."); }) as unknown as typeof fetch,
    }, selection)).rejects.toThrow("Agent source cache integrity check failed");
  } finally {
    root.dispose();
  }
});

test("legacy clean V1 source cache remains reusable", async () => {
  const root = fixture();
  try {
    root.write("repository/payload/data.txt", "clean\n");
    const bytes = await archive(root.root);
    const cacheDirectory = path.join(root.root, "cache");
    const source = { repository: "owner/legacy-clean", commit: COMMIT };
    const cached = await resolvePinnedSource(source, {
      cacheDirectory,
      fetchImpl: (async () => new Response(bytes, { status: 200 })) as unknown as typeof fetch,
    });
    const markerPath = path.join(cached.root, ".sherpa-source-cache.json");
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>;
    delete marker.skippedSymlinks;
    writeFileSync(markerPath, `${JSON.stringify(marker)}\n`);
    const statePath = path.join(cacheDirectory, "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8")) as { sources: Record<string, Record<string, unknown>> };
    delete Object.values(state.sources)[0]!.skippedSymlinks;
    writeFileSync(statePath, `${JSON.stringify(state)}\n`);

    const reused = await resolvePinnedSource(source, {
      cacheDirectory,
      fetchImpl: (async () => { throw new Error("Legacy clean cache must be reused."); }) as unknown as typeof fetch,
    });
    expect(reused.cacheHit).toBe(true);
    expect(reused.marker.skippedSymlinks).toEqual({});
  } finally {
    root.dispose();
  }
});

test("pinned source cache allows repeated exact directory entries", async () => {
  const root = fixture();
  try {
    mkdirSync(path.join(root.root, "repository", "payload", "empty"), { recursive: true });
    const bytes = await archive(root.root, ["payload/empty", "payload/empty"]);
    const source = { repository: "owner/repeated-directory", commit: COMMIT };
    const cacheDirectory = path.join(root.root, "cache");
    const result = await resolvePinnedSource(source, {
      cacheDirectory,
      fetchImpl: (async () => new Response(bytes, { status: 200 })) as unknown as typeof fetch,
    });
    expect(result.marker.files).toEqual({});
    const warm = await resolvePinnedSource(source, {
      cacheDirectory,
      fetchImpl: (async () => { throw new Error("Valid warm cache must not fetch."); }) as unknown as typeof fetch,
    });
    expect(warm.cacheHit).toBe(true);
  } finally {
    root.dispose();
  }
});

test("pinned source cache rejects case-folded collisions in an existing inventory", async () => {
  const root = fixture();
  try {
    root.write("repository/payload/ReadMe.txt", "original\n");
    const bytes = await archive(root.root);
    const options = {
      cacheDirectory: path.join(root.root, "cache"),
      fetchImpl: (async () => new Response(bytes, { status: 200 })) as unknown as typeof fetch,
    };
    const cached = await resolvePinnedSource({ repository: "owner/inventory", commit: COMMIT }, options);
    writeFileSync(path.join(cached.root, "payload", "README.txt"), "collision\n");
    await expect(resolvePinnedSource({ repository: "owner/inventory", commit: COMMIT }, {
      ...options,
      fetchImpl: (async () => { throw new Error("Invalid cache must not fetch."); }) as unknown as typeof fetch,
    })).rejects.toThrow("Case-insensitive source path collision");
    expect(readFileSync(path.join(cached.root, "payload", "ReadMe.txt"), "utf8")).toBe("original\n");
    expect(readFileSync(path.join(cached.root, "payload", "README.txt"), "utf8")).toBe("collision\n");

    rmSync(path.join(cached.root, "payload", "README.txt"));
    mkdirSync(path.join(cached.root, "payload", "README.txt"));
    await expect(resolvePinnedSource({ repository: "owner/inventory", commit: COMMIT }, {
      ...options,
      fetchImpl: (async () => { throw new Error("Invalid cache must not fetch."); }) as unknown as typeof fetch,
    })).rejects.toThrow("Agent source cache integrity check failed");
  } finally {
    root.dispose();
  }
});
