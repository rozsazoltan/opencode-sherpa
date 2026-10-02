import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { resolvePinnedSource } from "../src/source-cache.ts";
import {
  configuredSherpaSkillSources,
  declaredSkillIds,
  resolveSherpaSkillSources,
} from "../src/skill-sources.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "sherpa-skill-source-test-"));
  const write = (relative: string, contents: string | Buffer) => {
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

async function makeArchive(root: string, files: string[]): Promise<Buffer> {
  const target = path.join(root, "source.tgz");
  await tar.c({ cwd: path.join(root, "repository"), file: target, gzip: true, prefix: `repo-${COMMIT}` }, files);
  return readFileSync(target);
}

function mockFetch(bytes: Buffer, onFetch?: () => void): typeof fetch {
  return (async () => {
    onFetch?.();
    return new Response(bytes, { status: 200 });
  }) as unknown as typeof fetch;
}

test("skill source configuration pins defaults and supports replacement or append semantics", () => {
  const defaults = configuredSherpaSkillSources(undefined);
  expect(defaults.map(({ namespace }) => namespace)).toEqual(["superpowers", "antfu", "nuno", "asyraf", "leonardomso", "mattpocock"]);
  expect(declaredSkillIds(defaults)).toContain("sherpa-leonardomso-rust-skills");
  expect(defaults.find(({ namespace }) => namespace === "nuno")?.license).toBe("MIT");
  expect(defaults.find(({ namespace }) => namespace === "leonardomso")?.skills[0]?.supportPaths).toEqual(["rules"]);
  expect(configuredSherpaSkillSources([])).toEqual([]);
  expect(configuredSherpaSkillSources({ sources: [], includeDefaults: false })).toEqual([]);
  expect(configuredSherpaSkillSources({ sources: [] })).toEqual(defaults);
  expect(configuredSherpaSkillSources({ sources: [], includeDefaults: true }).length).toBe(defaults.length);
});

test("validates every configuration before fetch and ignores unselected upstream entries", async () => {
  const invalid = [
    { namespace: "bad", repository: "owner/repo", commit: COMMIT, license: "MIT", unexpected: true, skills: [] },
  ];
  expect(() => configuredSherpaSkillSources(invalid)).toThrow("Unsupported skill source field 'unexpected'");
  expect(() => configuredSherpaSkillSources([{
    namespace: "dupe", repository: "owner/repo", commit: COMMIT, license: "MIT",
    skills: [{ id: "one", path: "skills/one/SKILL.md" }, { id: "one", path: "skills/two/SKILL.md" }],
  }])).toThrow("Duplicate skill ID");
  expect(() => configuredSherpaSkillSources([{
    namespace: "root", repository: "owner/repo", commit: COMMIT, license: "MIT",
    skills: [{ id: "one", path: "SKILL.md" }],
  }])).toThrow("requires explicit supportPaths");

  const root = fixture();
  let fetches = 0;
  try {
    const sources = configuredSherpaSkillSources([{
      namespace: "selected", repository: "owner/selected", commit: COMMIT, license: "MIT",
      skills: [
        { id: "good", path: "skills/good/SKILL.md" },
        { id: "missing", path: "skills/missing/SKILL.md" },
      ],
    }, {
      namespace: "optional-bad", repository: "owner/unavailable", commit: "a".repeat(40), license: "MIT",
      skills: [{ id: "broken", path: "skills/broken/SKILL.md" }],
    }]);
    const ids = declaredSkillIds(sources);
    await expect(resolveSherpaSkillSources(sources, {
      skillIds: ["sherpa-selected-unknown"],
      cacheDirectory: path.join(root.root, "cache"),
      fetchImpl: mockFetch(Buffer.alloc(0), () => fetches++),
    })).rejects.toThrow("Unknown Sherpa skill ID");
    expect(fetches).toBe(0);
    expect(ids).toEqual(["sherpa-selected-good", "sherpa-selected-missing", "sherpa-optional-bad-broken"]);
    root.write("repository/skills/good/SKILL.md", "---\ndescription: Good skill.\nlicense: MIT\n---\nBody.\n");
    const archive = await makeArchive(root.root, ["skills/good/SKILL.md"]);
    const selected = await resolveSherpaSkillSources(sources, {
      skillIds: ["sherpa-selected-good"],
      cacheDirectory: path.join(root.root, "selected-cache"),
      fetchImpl: mockFetch(archive, () => fetches++),
    });
    expect(selected.skills.map(({ id }) => id)).toEqual(["sherpa-selected-good"]);
    expect(selected.diagnostics).toEqual([]);
    expect(fetches).toBe(1);
  } finally {
    root.dispose();
  }
});

test("packages selected skill bytes, exact full license, and stable provenance", async () => {
  const root = fixture();
  try {
    const license = Buffer.from("MIT License\r\nCopyright (c) Fixture\r\n\0", "utf8");
    const skill = Buffer.from([
      "\uFEFF---",
      "name: Upstream Display Name",
      "description: Uses upstream metadata without rewriting frontmatter.",
      "license: MIT",
      "metadata:",
      "  opencode/autoinvoke: true",
      "---",
      "# Original Body",
      "\r\nUse exact upstream bytes.",
      "",
    ].join("\r\n"));
    const reference = Buffer.from([0, 255, 1, 2, 3]);
    const mixedCaseReference = Buffer.from("Keep original path spelling.\n");
    root.write("repository/LICENSE", license);
    root.write("repository/skills/example/SKILL.md", skill);
    root.write("repository/skills/example/references/opaque.bin", reference);
    root.write("repository/skills/example/references/ReadMe.txt", mixedCaseReference);
    const archive = await makeArchive(root.root, [
      "LICENSE", "skills/example/SKILL.md", "skills/example/references/opaque.bin",
      "skills/example/references/ReadMe.txt",
    ]);
    const source = configuredSherpaSkillSources([{
      namespace: "fixture", repository: "Example/Skills", commit: COMMIT, licensePath: "LICENSE",
      skills: [{ id: "renamed", path: "skills/example/SKILL.md" }],
    }]);
    const options = { cacheDirectory: path.join(root.root, "cache"), fetchImpl: mockFetch(archive) };
    const first = await resolveSherpaSkillSources(source, options);
    expect(first.diagnostics).toEqual([]);
    expect(first.skills[0]).toMatchObject({
      id: "sherpa-fixture-renamed",
      name: "Upstream Display Name",
      description: "Uses upstream metadata without rewriting frontmatter.",
      autoinvoke: true,
      content: "# Original Body\r\n\r\nUse exact upstream bytes.",
    });
    const files = first.skills[0]!.files!;
    expect(files.get("SKILL.md")).toEqual(skill);
    expect(files.get("references/opaque.bin")).toEqual(reference);
    expect(files.get("references/ReadMe.txt")).toEqual(mixedCaseReference);
    expect(files.has("references/readme.txt")).toBe(false);
    expect(files.get("SHERPA-LICENSE.txt")).toEqual(license);
    const provenance = files.get("SHERPA-SOURCE.json")!.toString("utf8");
    expect(provenance).toContain('"repository":"example/skills"');
    expect(provenance).toContain(`"commit":"${COMMIT}"`);
    expect(provenance).toContain('"sourcePath":"skills/example/SKILL.md"');
    expect(provenance).not.toContain("cacheHit");
    expect(provenance).not.toContain("timestamp");
    const shared = await resolvePinnedSource({ repository: "example/skills", commit: COMMIT }, {
      cacheDirectory: options.cacheDirectory,
      fetchImpl: (async () => { throw new Error("Skill cache must be shared with other pinned sources."); }) as unknown as typeof fetch,
    });
    expect(shared.cacheHit).toBe(true);
    const second = await resolveSherpaSkillSources(source, {
      ...options,
      fetchImpl: (async () => { throw new Error("Cache should avoid fetching."); }) as unknown as typeof fetch,
    });
    expect(second.skills[0]?.files?.get("SHERPA-SOURCE.json")).toEqual(files.get("SHERPA-SOURCE.json"));
    expect(second.skills[0]?.files?.get("SKILL.md")).toEqual(skill);
  } finally {
    root.dispose();
  }
});

test("declared license fallback must match frontmatter and does not invent license text", async () => {
  const root = fixture();
  try {
    root.write("repository/skills/good/SKILL.md", "---\ndescription: Good skill.\nlicense: MIT\n---\nBody.\n");
    root.write("repository/skills/bad/SKILL.md", "---\ndescription: Bad skill.\nlicense: ISC\n---\nBody.\n");
    const archive = await makeArchive(root.root, ["skills/good/SKILL.md", "skills/bad/SKILL.md"]);
    const sources = configuredSherpaSkillSources([{
      namespace: "fallback", repository: "owner/repo", commit: COMMIT, license: "MIT",
      skills: [
        { id: "good", path: "skills/good/SKILL.md", supportPaths: [] },
        { id: "bad", path: "skills/bad/SKILL.md", supportPaths: [] },
      ],
    }]);
    const result = await resolveSherpaSkillSources(sources, {
      cacheDirectory: path.join(root.root, "cache"), fetchImpl: mockFetch(archive),
    });
    expect(result.skills.map(({ id }) => id)).toEqual(["sherpa-fallback-good"]);
    expect(result.skills[0]?.files?.has("SHERPA-LICENSE.txt")).toBe(false);
    expect(result.skills[0]?.files?.get("SHERPA-SOURCE.json")?.toString("utf8")).toContain('"kind":"declared"');
    expect(result.diagnostics).toMatchObject([{ code: "invalid-license", skillId: "sherpa-fallback-bad" }]);
  } finally {
    root.dispose();
  }
});

test("root skill supports exact selected rule directory and rejects reserved-name collision", async () => {
  const root = fixture();
  try {
    root.write("repository/SKILL.md", "---\ndescription: Root skill.\nlicense: MIT\n---\nRoot body.\n");
    root.write("repository/rules/current.md", "Current rules.\n");
    root.write("repository/checks/ignored.md", "Do not copy.\n");
    root.write("repository/README.md", "Do not copy.\n");
    const archive = await makeArchive(root.root, ["SKILL.md", "rules", "checks", "README.md"]);
    const sources = configuredSherpaSkillSources([{
      namespace: "root", repository: "owner/root", commit: COMMIT, license: "MIT",
      skills: [{ id: "rules", path: "SKILL.md", supportPaths: ["rules"] }],
    }]);
    const result = await resolveSherpaSkillSources(sources, {
      cacheDirectory: path.join(root.root, "cache"), fetchImpl: mockFetch(archive),
    });
    expect([...result.skills[0]!.files!.keys()].sort()).toEqual(["SHERPA-SOURCE.json", "SKILL.md", "rules/current.md"]);

    root.write("repository/SHERPA-SOURCE.json", "Upstream collision.\n");
    const collisionArchive = await makeArchive(root.root, ["SKILL.md", "rules", "SHERPA-SOURCE.json"]);
    const collisionSources = configuredSherpaSkillSources([{
      namespace: "root", repository: "owner/root", commit: COMMIT, license: "MIT",
      skills: [{ id: "rules", path: "SKILL.md", supportPaths: ["rules", "SHERPA-SOURCE.json"] }],
    }]);
    const collision = await resolveSherpaSkillSources(collisionSources, {
      cacheDirectory: path.join(root.root, "cache-collision"), fetchImpl: mockFetch(collisionArchive),
    });
    expect(collision.skills).toEqual([]);
    expect(collision.diagnostics[0]?.code).toBe("invalid-skill");
    expect(collision.diagnostics[0]?.message).toContain("reserved Sherpa file");
  } finally {
    root.dispose();
  }
});

test("skill selection omits root aliases outside selected Rust files and rules tree", async () => {
  const root = fixture();
  try {
    root.write("repository/SKILL.md", "---\ndescription: Rust skills.\nlicense: MIT\n---\nRust body.\n");
    root.write("repository/rules/format.md", "Formatting rules.\n");
    root.link("repository/AGENTS.md", "SKILL.md");
    root.link("repository/CLAUDE.md", "SKILL.md");
    const archive = await makeArchive(root.root, ["SKILL.md", "rules", "AGENTS.md", "CLAUDE.md"]);
    const sources = configuredSherpaSkillSources([{
      namespace: "rust",
      repository: "owner/rust-fixture",
      commit: COMMIT,
      license: "MIT",
      skills: [{ id: "rules", path: "SKILL.md", supportPaths: ["rules"] }],
    }]);
    const cacheDirectory = path.join(root.root, "cache");
    const options = { cacheDirectory, fetchImpl: mockFetch(archive) };
    const result = await resolveSherpaSkillSources(sources, options);
    expect(result.diagnostics).toEqual([]);
    expect([...result.skills[0]!.files!.keys()].sort()).toEqual([
      "SHERPA-SOURCE.json", "SKILL.md", "rules/format.md",
    ]);
    const cached = await resolvePinnedSource({ repository: "owner/rust-fixture", commit: COMMIT }, {
      cacheDirectory,
      fetchImpl: (async () => { throw new Error("Selection-aware cache must be reused."); }) as unknown as typeof fetch,
    }, { files: ["SKILL.md"], trees: ["rules"] });
    expect(cached.marker.skippedSymlinks).toEqual({ "AGENTS.md": "SKILL.md", "CLAUDE.md": "SKILL.md" });
    expect(existsSync(path.join(cached.root, "AGENTS.md"))).toBe(false);
    expect(existsSync(path.join(cached.root, "CLAUDE.md"))).toBe(false);
  } finally {
    root.dispose();
  }
});

test("nested skill selection protects complete skill tree but omits unrelated root aliases", async () => {
  const root = fixture();
  try {
    root.write("repository/skills/one/SKILL.md", "---\ndescription: Nested skill.\nlicense: MIT\n---\nBody.\n");
    root.write("repository/skills/one/references/guide.md", "Selected nested support.\n");
    root.link("repository/AGENTS.md", "CLAUDE.md");
    root.link("repository/CLAUDE.md", "skills/one/SKILL.md");
    const archive = await makeArchive(root.root, ["skills/one", "AGENTS.md", "CLAUDE.md"]);
    const sources = configuredSherpaSkillSources([{
      namespace: "matt",
      repository: "owner/matt-fixture",
      commit: COMMIT,
      license: "MIT",
      skills: [{ id: "nested", path: "skills/one/SKILL.md" }],
    }]);
    const cacheDirectory = path.join(root.root, "cache");
    const result = await resolveSherpaSkillSources(sources, { cacheDirectory, fetchImpl: mockFetch(archive) });
    expect(result.diagnostics).toEqual([]);
    expect(result.skills[0]?.files?.get("references/guide.md")?.toString()).toBe("Selected nested support.\n");
    const cached = await resolvePinnedSource({ repository: "owner/matt-fixture", commit: COMMIT }, {
      cacheDirectory,
      fetchImpl: (async () => { throw new Error("Selection-aware cache must be reused."); }) as unknown as typeof fetch,
    }, { files: ["skills/one/SKILL.md"], trees: ["skills/one"] });
    expect(cached.marker.skippedSymlinks).toEqual({ "AGENTS.md": "CLAUDE.md", "CLAUDE.md": "skills/one/SKILL.md" });
  } finally {
    root.dispose();
  }
});

test("skill source rejects symlinks intersecting skill, support, ancestor, nested tree, or license", async () => {
  const aliases = [
    "skills/demo/SKILL.md",
    "skills/demo",
    "skills/demo/references",
    "skills/demo/references/nested/guide.md",
    "LICENSE",
    "skills/nested/docs/extra.md",
    "skills/nested/references/guide.md",
  ];
  const root = fixture();
  try {
    for (const [index, alias] of aliases.entries()) {
      root.link(`repository/${alias}`, "outside.txt");
      const archive = await makeArchive(root.root, [alias]);
      const skillsPath = alias.startsWith("skills/nested/") ? "skills/nested/SKILL.md" : "skills/demo/SKILL.md";
      const supportPath = alias.startsWith("skills/nested/") ? "docs" : "references";
      const supportPaths = alias === "skills/nested/references/guide.md" ? undefined : [supportPath];
      const sources = configuredSherpaSkillSources([{
        namespace: `protected-${index}`,
        repository: `owner/protected-${index}`,
        commit: COMMIT,
        licensePath: "LICENSE",
        skills: [{ id: "demo", path: skillsPath, ...(supportPaths === undefined ? {} : { supportPaths }) }],
      }]);
      const result = await resolveSherpaSkillSources(sources, {
        cacheDirectory: path.join(root.root, `cache-${index}`),
        fetchImpl: mockFetch(archive),
      });
      expect(result.skills).toEqual([]);
      expect(result.diagnostics[0]?.code).toBe("source-unavailable");
      expect(result.diagnostics[0]?.message).toContain("affects selected skill path");
      rmSync(path.join(root.root, "repository/skills"), { recursive: true, force: true });
      rmSync(path.join(root.root, `repository/${alias}`), { force: true });
    }
  } finally {
    root.dispose();
  }
});
