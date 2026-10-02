import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { configuredProjectDetection, detectProject } from "../src/project-detection.ts";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "sherpa-project-detection-"));
  const write = (relative: string, content: string) => {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  return { root, write, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

function syntheticDirectory(count: number): fs.Dir {
  let emitted = 0;
  return {
    readSync() {
      if (emitted >= count) return null;
      emitted += 1;
      return {
        name: `unmatched-${emitted}`,
        isDirectory: () => false,
        isFile: () => true,
        isBlockDevice: () => false,
        isCharacterDevice: () => false,
        isFIFO: () => false,
        isSocket: () => false,
        isSymbolicLink: () => false,
      } as fs.Dirent;
    },
    closeSync() {},
  } as fs.Dir;
}

function mockPath(call: readonly unknown[]): string {
  return String(call[0]);
}

test("detects mixed workspace stacks and dependency features deterministically", () => {
  const source = fixture();
  try {
    source.write("package.json", JSON.stringify({
      workspaces: { packages: ["packages/*"] },
      devDependencies: { typescript: "^5", turbo: "^2" },
    }));
    source.write("pnpm-workspace.yaml", "packages:\n  - 'apps/*'\n  - 'libs/*'\n");
    source.write("composer.json", JSON.stringify({
      require: { "laravel/framework": "^11" },
      "require-dev": { "pestphp/pest": "^3", "phpunit/phpunit": "^11" },
    }));
    source.write("Cargo.toml", "[workspace]\nmembers = [\"crates/*\"]\nexclude = [\"crates/ignored\"]\n");
    source.write("apps/admin/package.json", JSON.stringify({ dependencies: { "@angular/core": "^19", vite: "^6" } }));
    source.write("packages/web/package.json", JSON.stringify({ dependencies: { vue: "^3", gsap: "^3" } }));
    source.write("libs/php/composer.json", JSON.stringify({ require: { "symfony/framework-bundle": "^7" } }));
    source.write("crates/api/Cargo.toml", "[dependencies]\naxum = \"0.8\"\ntokio = \"1\"\n");
    source.write("crates/ignored/Cargo.toml", "[dependencies]\nserde = \"1\"\n");
    source.write("packages/engine/package.json", JSON.stringify({ workspaces: ["rust-members/*"] }));
    source.write("packages/engine/Cargo.toml", "[workspace]\nmembers = [\"rust-members/*\"]\n");
    source.write("packages/engine/rust-members/core/Cargo.toml", "[dependencies]\nserde = \"1\"\n");

    const detected = detectProject(source.root);
    expect(detected.stacks).toEqual(["js", "php", "rust"]);
    expect(detected.features).toEqual([
      "angular", "axum", "gsap", "laravel", "pest", "phpunit", "serde", "symfony", "tokio", "turbo", "typescript", "vite", "vue",
    ]);
    expect(detected.evidence.map(({ path: manifest, stack }) => `${manifest}:${stack}`)).toEqual([
      "Cargo.toml:rust",
      "apps/admin/package.json:js",
      "composer.json:php",
      "crates/api/Cargo.toml:rust",
      "libs/php/composer.json:php",
      "package.json:js",
      "packages/engine/Cargo.toml:rust",
      "packages/engine/package.json:js",
      "packages/engine/rust-members/core/Cargo.toml:rust",
      "packages/web/package.json:js",
    ]);
    expect(detected.directories).toEqual([
      ".", "apps/admin", "crates/api", "libs/php", "packages/engine", "packages/engine/rust-members/core", "packages/web",
    ]);
    expect(detectProject(source.root)).toEqual(detected);
  } finally {
    source.dispose();
  }
});

test("ignores inherited dependency feature mappings", () => {
  const source = fixture();
  try {
    source.write("package.json", '{"dependencies":{"constructor":"1.0.0","__proto__":"1.0.0","toString":"1.0.0","vue":"^3"}}');
    source.write("composer.json", '{"require":{"constructor":"1.0.0","__proto__":"1.0.0","toString":"1.0.0","laravel/framework":"^11"}}');

    const result = detectProject(source.root);
    expect(result.features).toEqual(["laravel", "vue"]);
    expect(result.evidence.map(({ features }) => features)).toEqual([["laravel"], ["vue"]]);
  } finally {
    source.dispose();
  }
});

test("detects pnpm only from a versioned packageManager field and maps modern Vue tooling", () => {
  const source = fixture();
  try {
    source.write("package.json", JSON.stringify({
      packageManager: "pnpm@9.12.0",
      dependencies: {
        "@pinia/nuxt": "^0.9",
        "@unocss/vite": "^0.6",
        pinia: "^2",
        vitepress: "^1",
      },
    }));
    expect(detectProject(source.root).features).toEqual(["pinia", "pnpm", "unocss", "vitepress"]);

    for (const packageManager of ["pnpm@", "pnpm@   ", "npm@10.0.0", "bun@1.0.0"]) {
      source.write("package.json", JSON.stringify({ packageManager }));
      expect(detectProject(source.root).features).toEqual([]);
    }
  } finally {
    source.dispose();
  }
});

test("detects Fortify and Wayfinder only from Laravel Composer dependencies", () => {
  const source = fixture();
  try {
    source.write("composer.json", JSON.stringify({
      require: { "laravel/framework": "^11" },
    }));
    source.write("package.json", JSON.stringify({ dependencies: { react: "^19", vue: "^3" } }));
    expect(detectProject(source.root).features).toEqual(["laravel", "react", "vue"]);

    source.write("composer.json", JSON.stringify({
      require: { "laravel/framework": "^11", "laravel/fortify": "^1" },
      "require-dev": { "laravel/wayfinder": "^0.1" },
    }));
    expect(detectProject(source.root).features).toEqual(["fortify", "laravel", "react", "vue", "wayfinder"]);
  } finally {
    source.dispose();
  }
});

test("supports pnpm .yml and explicit relative glob paths, while excluding generated trees", () => {
  const source = fixture();
  try {
    source.write("pnpm-workspace.yml", "packages:\n  - 'workspace/*'\n");
    source.write("workspace/ui/package.json", JSON.stringify({ dependencies: { react: "^19", vitest: "^3" } }));
    source.write("custom/php/composer.json", JSON.stringify({ require: { "phpunit/phpunit": "^11" } }));
    source.write("node_modules/ignored/package.json", JSON.stringify({ dependencies: { next: "^15" } }));
    source.write("vendor/ignored/composer.json", JSON.stringify({ require: { "laravel/framework": "^11" } }));
    source.write("dist/ignored/Cargo.toml", "[dependencies]\ntokio = \"1\"\n");

    const result = detectProject(source.root, { paths: ["custom/*"] });
    expect(result.stacks).toEqual(["js", "php"]);
    expect(result.features).toEqual(["phpunit", "react", "vitest"]);
    expect(result.evidence.map(({ path: manifest }) => manifest)).toEqual([
      "custom/php/composer.json", "workspace/ui/package.json",
    ]);
  } finally {
    source.dispose();
  }
});

test("rejects ambiguous workspace extensions and malformed workspace or manifest data", () => {
  const source = fixture();
  try {
    source.write("pnpm-workspace.yaml", "packages: []\n");
    source.write("pnpm-workspace.yml", "packages: []\n");
    expect(() => detectProject(source.root)).toThrow("both pnpm-workspace.yaml and pnpm-workspace.yml");

    rmSync(path.join(source.root, "pnpm-workspace.yml"));
    source.write("pnpm-workspace.yaml", "packages: [\n");
    expect(() => detectProject(source.root)).toThrow("malformed YAML workspace config");

    rmSync(path.join(source.root, "pnpm-workspace.yaml"));
    source.write("package.json", "{ broken");
    expect(() => detectProject(source.root)).toThrow("malformed JSON manifest: package.json");

    writeFileSync(path.join(source.root, "package.json"), JSON.stringify({ workspaces: { packages: "packages/*" } }));
    expect(() => detectProject(source.root)).toThrow("workspace paths must be an array of strings");

    writeFileSync(path.join(source.root, "package.json"), JSON.stringify({}));
    source.write("Cargo.toml", "[workspace\n");
    expect(() => detectProject(source.root)).toThrow("malformed TOML manifest: Cargo.toml");
  } finally {
    source.dispose();
  }
});

test("does not follow symlinked workspace paths or scan excluded directories", () => {
  const source = fixture();
  const outside = fixture();
  try {
    outside.write("secret/package.json", JSON.stringify({ dependencies: { next: "^15" } }));
    source.write("package.json", JSON.stringify({ workspaces: ["links/*", "**/*"] }));
    source.write(".git/private/package.json", JSON.stringify({ dependencies: { nuxt: "^3" } }));
    source.write(".opencode/private/package.json", JSON.stringify({ dependencies: { react: "^19" } }));
    source.write("node_modules/glob/private/package.json", "{ malformed");
    mkdirSync(path.join(source.root, "links"), { recursive: true });
    try {
      symlinkSync(path.join(outside.root, "secret"), path.join(source.root, "links/escape"), "dir");
    } catch (error) {
      if (error instanceof Error && "code" in error && ["EACCES", "EPERM", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"].includes(String(error.code))) return;
      throw error;
    }

    const opened = spyOn(fs, "opendirSync");
    const read = spyOn(fs, "readFileSync");
    try {
      const detected = detectProject(source.root, { paths: ["node_modules/glob/*", "links/escape/*"] });
      expect(detected.stacks).toEqual(["js"]);
      expect(detected.evidence.map(({ path: manifest }) => manifest)).toEqual(["package.json"]);
      expect(detected.features).toEqual([]);
      const openedPaths = opened.mock.calls.map((call) => mockPath(call));
      const readPaths = read.mock.calls.map((call) => mockPath(call));
      expect(openedPaths.some((entry) => entry.startsWith(path.join(source.root, "node_modules")))).toBe(false);
      expect(openedPaths.some((entry) => entry.startsWith(path.join(source.root, "links", "escape")))).toBe(false);
      expect(readPaths.some((entry) => entry.startsWith(path.join(outside.root)))).toBe(false);
      expect(readPaths.some((entry) => entry.includes(`${path.sep}node_modules${path.sep}`))).toBe(false);
    } finally {
      opened.mockRestore();
      read.mockRestore();
    }
  } finally {
    source.dispose();
    outside.dispose();
  }
});

test("pnpm YAML and YML exclusions override convention discovery without hiding PHP", () => {
  for (const workspaceFile of ["pnpm-workspace.yaml", "pnpm-workspace.yml"]) {
    const source = fixture();
    try {
      source.write(workspaceFile, "packages:\n  - '!packages/next-app'\n  - 'packages/*'\n  - '!packages/broken'\n");
      source.write("packages/next-app/package.json", JSON.stringify({ dependencies: { next: "^15" } }));
      source.write("packages/broken/package.json", "{ malformed");
      source.write("packages/broken/composer.json", JSON.stringify({ require: { "laravel/framework": "^11" } }));

      const read = spyOn(fs, "readFileSync");
      try {
        const result = detectProject(source.root);
        expect(result.stacks).toEqual(["php"]);
        expect(result.features).toEqual(["laravel"]);
        expect(result.evidence.map(({ path: manifest }) => manifest)).toEqual(["packages/broken/composer.json"]);
        const readPaths = read.mock.calls.map((call) => mockPath(call));
        expect(readPaths).not.toContain(path.join(source.root, "packages/next-app/package.json"));
        expect(readPaths).not.toContain(path.join(source.root, "packages/broken/package.json"));
      } finally {
        read.mockRestore();
      }
    } finally {
      source.dispose();
    }
  }
});

test("package workspace exclusions override convention discovery in either pattern order", () => {
  const source = fixture();
  try {
    source.write("package.json", JSON.stringify({ workspaces: ["!packages/next-app", "packages/*", "!packages/broken"] }));
    source.write("packages/next-app/package.json", JSON.stringify({ dependencies: { next: "^15" } }));
    source.write("packages/broken/package.json", "{ malformed");
    source.write("packages/broken/composer.json", JSON.stringify({ require: { "phpunit/phpunit": "^11" } }));

    const read = spyOn(fs, "readFileSync");
    try {
      const result = detectProject(source.root);
      expect(result.stacks).toEqual(["js", "php"]);
      expect(result.features).toEqual(["phpunit"]);
      expect(result.evidence.map(({ path: manifest }) => manifest)).toEqual([
        "package.json", "packages/broken/composer.json",
      ]);
      const readPaths = read.mock.calls.map((call) => mockPath(call));
      expect(readPaths).not.toContain(path.join(source.root, "packages/next-app/package.json"));
      expect(readPaths).not.toContain(path.join(source.root, "packages/broken/package.json"));
    } finally {
      read.mockRestore();
    }
  } finally {
    source.dispose();
  }
});

test("Cargo exclusions skip malformed crates and do not expand excluded workspaces", () => {
  const source = fixture();
  try {
    source.write("Cargo.toml", "[workspace]\nmembers = [\"crates/*\"]\nexclude = [\"crates/ignored\", \"crates/ignored-workspace\"]\n");
    source.write("crates/ignored/Cargo.toml", "[workspace\n");
    source.write("crates/ignored-workspace/Cargo.toml", "[workspace]\nmembers = [\"nested/*\"]\n");
    source.write("crates/ignored-workspace/nested/member/Cargo.toml", "[dependencies]\ntokio = \"1\"\n");
    source.write("crates/api/Cargo.toml", "[dependencies]\naxum = \"0.8\"\n");

    const read = spyOn(fs, "readFileSync");
    try {
      const result = detectProject(source.root);
      expect(result.features).toEqual(["axum"]);
      expect(result.evidence.map(({ path: manifest }) => manifest)).toEqual([
        "Cargo.toml", "crates/api/Cargo.toml",
      ]);
      const readPaths = read.mock.calls.map((call) => mockPath(call));
      expect(readPaths).not.toContain(path.join(source.root, "crates/ignored/Cargo.toml"));
      expect(readPaths).not.toContain(path.join(source.root, "crates/ignored-workspace/Cargo.toml"));
      expect(readPaths).not.toContain(path.join(source.root, "crates/ignored-workspace/nested/member/Cargo.toml"));
    } finally {
      read.mockRestore();
    }
  } finally {
    source.dispose();
  }
});

test("explicit child discovery applies workspace exclusions from safe ancestors first", () => {
  const source = fixture();
  try {
    source.write("parent/package.json", JSON.stringify({ workspaces: ["!blocked"] }));
    source.write("parent/blocked/package.json", "{ malformed");
    source.write("parent/blocked/child/package.json", JSON.stringify({ dependencies: { next: "^15" } }));
    source.write("parent/blocked/child/composer.json", JSON.stringify({ require: { "symfony/framework-bundle": "^7" } }));

    const read = spyOn(fs, "readFileSync");
    try {
      const result = detectProject(source.root, { paths: ["parent/blocked/child"] });
      expect(result.stacks).toEqual(["php"]);
      expect(result.features).toEqual(["symfony"]);
      expect(result.evidence.map(({ path: manifest }) => manifest)).toEqual([
        "parent/blocked/child/composer.json",
      ]);
      const readPaths = read.mock.calls.map((call) => mockPath(call));
      expect(readPaths).not.toContain(path.join(source.root, "parent/blocked/package.json"));
      expect(readPaths).not.toContain(path.join(source.root, "parent/blocked/child/package.json"));
      expect(readPaths).toContain(path.join(source.root, "parent/package.json"));
    } finally {
      read.mockRestore();
    }
  } finally {
    source.dispose();
  }
});

test("rejects brace traversal before opening any directory", () => {
  const source = fixture();
  try {
    const opened = spyOn(fs, "opendirSync");
    try {
      expect(() => detectProject(source.root, { paths: ["{..,apps}/*"] })).toThrow("Unsupported project detection glob syntax");
      expect(opened).not.toHaveBeenCalled();
    } finally {
      opened.mockRestore();
    }
  } finally {
    source.dispose();
  }
});

test("wide nonmatching entries still consume shared filesystem budget", () => {
  const source = fixture();
  try {
    const opened = spyOn(fs, "opendirSync").mockImplementation(() => syntheticDirectory(30_000));
    try {
      expect(() => detectProject(source.root, { paths: ["no-match/*"] })).toThrow("filesystem entry/read units");
      expect(opened).toHaveBeenCalledTimes(1);
    } finally {
      opened.mockRestore();
    }
  } finally {
    source.dispose();
  }
});

test("workspace include and exclusion traversals share entry budget", () => {
  const source = fixture();
  try {
    source.write("package.json", JSON.stringify({ workspaces: ["no-a/*", "no-c/*", "!no-b/*"] }));
    const opened = spyOn(fs, "opendirSync").mockImplementation(() => syntheticDirectory(7_000));
    try {
      expect(() => detectProject(source.root)).toThrow("filesystem entry/read units");
      expect(opened).toHaveBeenCalledTimes(3);
    } finally {
      opened.mockRestore();
    }
  } finally {
    source.dispose();
  }
});

test("validates options strictly and disabled detection performs no filesystem discovery", () => {
  expect(configuredProjectDetection({ enabled: false, paths: ["apps/*"] })).toEqual({ enabled: false, paths: ["apps/*"] });
  expect(() => configuredProjectDetection({ enabled: "false" })).toThrow("'enabled' must be a boolean");
  expect(() => configuredProjectDetection({ paths: "apps/*" })).toThrow("'paths' must be an array");
  expect(() => configuredProjectDetection({ paths: ["../outside"] })).toThrow("traversal segments");
  expect(() => configuredProjectDetection({ paths: ["{..,apps}/*"] })).toThrow("Unsupported project detection glob syntax");
  expect(() => configuredProjectDetection({ paths: ["/tmp/outside"] })).toThrow("must be relative");
  expect(() => configuredProjectDetection({ extra: true })).toThrow("Unknown project detection option");
  expect(detectProject("/not/a/project", { enabled: false })).toEqual({
    stacks: [], features: [], evidence: [], directories: [],
  });
});
