import fs from "node:fs";
import path from "node:path";
import { minimatch } from "minimatch";
import { parse as parseTomlDocument } from "smol-toml";
import { parse as parseYaml } from "yaml";

export type ProjectStack = "php" | "js" | "rust";

export interface ProjectDetection {
  readonly stacks: ProjectStack[];
  readonly features: string[];
  readonly evidence: { path: string; stack: ProjectStack; features: string[] }[];
  readonly directories: string[];
}

export interface ProjectDetectionOptions {
  readonly enabled?: boolean;
  readonly paths?: readonly string[];
}

const EXCLUDED_DIRECTORIES = new Set([
  ".cache", ".git", ".opencode", "build", "coverage", "dist", "node_modules", "target", "vendor",
]);
const MAX_DEPTH = 10;
const MAX_MATCHES = 5_000;
const MAX_FILESYSTEM_UNITS = 20_000;
const MAX_CONFIG_DIRECTORIES = 5_000;
const MAX_PATTERNS = 128;
const STACK_ORDER: readonly ProjectStack[] = ["js", "php", "rust"];
const MATCH_OPTIONS = { dot: true, nonegate: true, nocomment: true, noext: true, nobrace: true } as const;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lexicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validatePattern(pattern: unknown, source: string): string {
  if (typeof pattern !== "string" || pattern.length === 0 || pattern.trim() !== pattern) {
    throw new Error(`Project detection paths must be non-empty relative glob strings (${source}).`);
  }
  if (path.posix.isAbsolute(pattern) || path.win32.isAbsolute(pattern) || /^[a-z]:/iu.test(pattern) || pattern.includes("\\")) {
    throw new Error(`Project detection path must be relative and use forward slashes: ${pattern}`);
  }
  const parts = pattern.split("/");
  if (parts.some((part) => part === ".." || part === ".")) {
    throw new Error(`Project detection path must not contain traversal segments: ${pattern}`);
  }
  if (parts.some((part) => part.length === 0) || parts.length > MAX_DEPTH) {
    throw new Error(`Project detection path must use 1-${MAX_DEPTH} non-empty segments: ${pattern}`);
  }
  if (parts.some((part) => part.includes("**") && part !== "**")) {
    throw new Error(`Unsupported project detection glob syntax: ${pattern}. Use literal segments, *, ?, or whole-segment ** only.`);
  }
  if (pattern.includes("\0") || /[{}()[\]!]/u.test(pattern)) {
    throw new Error(`Unsupported project detection glob syntax: ${pattern}. Use literal segments, *, ?, or whole-segment ** only.`);
  }
  return pattern;
}

function normalizeOptions(value: unknown): ProjectDetectionOptions {
  if (!isRecord(value)) throw new Error("Project detection options must be an object.");
  for (const key of Object.keys(value)) {
    if (key !== "enabled" && key !== "paths") throw new Error(`Unknown project detection option: ${key}`);
  }

  const enabled = value.enabled;
  if (enabled !== undefined && typeof enabled !== "boolean") {
    throw new Error("Project detection option 'enabled' must be a boolean.");
  }

  const pathsValue = value.paths;
  if (pathsValue !== undefined && !Array.isArray(pathsValue)) {
    throw new Error("Project detection option 'paths' must be an array of relative glob strings.");
  }
  const paths = pathsValue === undefined
    ? undefined
    : pathsValue.map((entry) => validatePattern(entry, "options.paths"));
  if (paths && paths.length > MAX_PATTERNS) {
    throw new Error(`Project detection supports at most ${MAX_PATTERNS} configured paths.`);
  }

  return {
    ...(enabled === undefined ? {} : { enabled }),
    ...(paths === undefined ? {} : { paths: [...new Set(paths)].sort(lexicalCompare) }),
  };
}

/** Strictly validate project-detection configuration before passing it to detectProject. */
export function configuredProjectDetection(value: unknown): ProjectDetectionOptions {
  return normalizeOptions(value);
}

function consume(budget: ScanBudget): void {
  budget.units += 1;
  if (budget.units > MAX_FILESYSTEM_UNITS) {
    throw new Error(`Project detection exceeded ${MAX_FILESYSTEM_UNITS} filesystem entry/read units.`);
  }
}

function lstatIfPresent(root: string, relative: string, budget: ScanBudget): ReturnType<typeof fs.lstatSync> | undefined {
  try {
    consume(budget);
    return fs.lstatSync(path.join(root, relative));
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isExcludedRelative(relative: string): boolean {
  return relative.split("/").some((part) => EXCLUDED_DIRECTORIES.has(part));
}

function safeDirectory(root: string, relative: string, budget: ScanBudget): boolean {
  if (!relative || relative === ".") {
    const rootStat = lstatIfPresent(root, ".", budget);
    return rootStat !== undefined && rootStat.isDirectory() && !rootStat.isSymbolicLink();
  }
  if (isExcludedRelative(relative)) return false;
  const rootStat = lstatIfPresent(root, ".", budget);
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) return false;
  let current = root;
  for (const part of relative.split("/")) {
    if (!part || part === "." || part === "..") return false;
    current = path.join(current, part);
    try {
      consume(budget);
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }
  return true;
}

interface ScanBudget {
  units: number;
  matches: number;
}

function directoryEntries(root: string, relative: string, budget: ScanBudget): string[] {
  if (!safeDirectory(root, relative, budget)) return [];
  const absolute = relative === "." ? root : path.join(root, ...relative.split("/"));
  let directory: fs.Dir;
  try {
    consume(budget);
    directory = fs.opendirSync(absolute);
  } catch (error) {
    if (isMissing(error) || (isRecord(error) && error.code === "ENOTDIR")) return [];
    throw error;
  }

  const children: string[] = [];
  try {
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) break;
      consume(budget);
      const child = relative === "." ? entry.name : `${relative}/${entry.name}`;
      if (isExcludedRelative(child) || entry.isSymbolicLink() || !entry.isDirectory()) continue;
      children.push(child);
    }
  } finally {
    directory.closeSync();
  }
  return children.sort(lexicalCompare);
}

function isWithin(relative: string, directories: readonly string[]): boolean {
  return directories.some((directory) => relative === directory || relative.startsWith(`${directory}/`));
}

function expandDirectories(
  root: string,
  patterns: readonly string[],
  source: string,
  budget: ScanBudget,
  blocked: readonly string[] = [],
  literalPrefix = ".",
): string[] {
  const validated = patterns.map((pattern) => validatePattern(pattern, source));
  const directories = new Set<string>();
  const prefixSegments = literalPrefix === "." ? [] : literalPrefix.split("/");
  for (const pattern of validated) {
    const segments = [...prefixSegments, ...pattern.split("/")];
    if (segments.length > MAX_DEPTH) {
      throw new Error(`Project detection path exceeds maximum depth ${MAX_DEPTH}: ${pattern}`);
    }
    const walk = (relative: string, index: number): void => {
      if (index === segments.length) {
        if (!relative || isWithin(relative, blocked) || !safeDirectory(root, relative, budget)) return;
        budget.matches += 1;
        if (budget.matches > MAX_MATCHES) {
          throw new Error(`Project detection exceeded ${MAX_MATCHES} matched directories.`);
        }
        directories.add(relative);
        return;
      }

      const segment = segments[index];
      if (segment === undefined) return;
      if (segment === "**" && index >= prefixSegments.length) {
        walk(relative, index + 1);
        if ((relative === "." ? 0 : relative.split("/").length) >= MAX_DEPTH) return;
        for (const child of directoryEntries(root, relative, budget)) {
          if (!isWithin(child, blocked)) walk(child, index);
        }
        return;
      }

      if ((relative === "." ? 0 : relative.split("/").length) >= MAX_DEPTH) return;
      for (const child of directoryEntries(root, relative, budget)) {
        const name = path.posix.basename(child);
        const matches = index < prefixSegments.length
          ? name === segment
          : minimatch(name, segment, MATCH_OPTIONS);
        if (matches && !isWithin(child, blocked)) {
          walk(child, index + 1);
        }
      }
    };
    walk(".", 0);
  }
  return [...directories].sort(lexicalCompare);
}

function readText(root: string, relative: string, budget: ScanBudget): string {
  consume(budget);
  return fs.readFileSync(path.join(root, relative), "utf8");
}

function readManifest(
  root: string,
  directory: string,
  filename: string,
  parse: (contents: string, file: string) => UnknownRecord,
  budget: ScanBudget,
): UnknownRecord | undefined {
  if (!safeDirectory(root, directory, budget)) return undefined;
  const relative = directory === "." ? filename : `${directory}/${filename}`;
  const stat = lstatIfPresent(root, relative, budget);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) return undefined;
  return parse(readText(root, relative, budget), relative);
}

function scheduleDirectory(
  pending: Map<string, boolean>,
  registered: Set<string>,
  directory: string,
  selected: boolean,
): void {
  const parts = directory === "." ? [] : directory.split("/");
  for (let length = 1; length <= parts.length; length += 1) {
    const ancestor = parts.slice(0, length).join("/");
    registered.add(ancestor);
    if (!pending.has(ancestor)) pending.set(ancestor, false);
  }
  if (directory === ".") pending.set(".", true);
  else pending.set(directory, pending.get(directory) === true || selected);
  if (registered.size > MAX_CONFIG_DIRECTORIES) {
    throw new Error(`Project detection exceeded ${MAX_CONFIG_DIRECTORIES} configured directories.`);
  }
}

function directoryDepth(directory: string): number {
  return directory === "." ? 0 : directory.split("/").length;
}

function takeNextDirectory(pending: Map<string, boolean>): [string, boolean] | undefined {
  const next = [...pending.keys()].sort((left, right) => directoryDepth(left) - directoryDepth(right) || lexicalCompare(left, right))[0];
  if (next === undefined) return undefined;
  const selected = pending.get(next) === true;
  pending.delete(next);
  return [next, selected];
}

function recordEvidence(
  evidence: ProjectDetection["evidence"],
  selected: boolean,
  file: string,
  stack: ProjectStack,
  features: string[],
): void {
  if (selected) evidence.push({ path: file, stack, features });
}

function addExcluded(target: Set<string>, directories: readonly string[]): void {
  for (const directory of directories) target.add(directory);
}

function workspaceDirectories(
  root: string,
  base: string,
  patterns: readonly string[],
  budget: ScanBudget,
  exclusions: readonly string[] = [],
): { directories: string[]; excluded: string[] } {
  const includes = patterns.filter((pattern) => !pattern.startsWith("!"));
  const negatives = patterns.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1));
  const exclusionPatterns = [...exclusions, ...negatives];
  const excluded = expandDirectories(root, exclusionPatterns, "workspace exclusion", budget, [], base);
  const found = expandDirectories(root, includes, "workspace declaration", budget, excluded, base);
  return {
    directories: found.filter((directory) => !isWithin(directory, excluded)),
    excluded,
  };
}

function isExcludedByWorkspace(directory: string, exclusions: ReadonlySet<string>): boolean {
  for (const exclusion of exclusions) {
    if (directory === exclusion || directory.startsWith(`${exclusion}/`)) return true;
  }
  return false;
}

function pnpmWorkspacePatterns(root: string, budget: ScanBudget): string[] {
  const yamlStat = lstatIfPresent(root, "pnpm-workspace.yaml", budget);
  const ymlStat = lstatIfPresent(root, "pnpm-workspace.yml", budget);
  if (yamlStat && ymlStat) {
    throw new Error("Project detection found both pnpm-workspace.yaml and pnpm-workspace.yml.");
  }
  const relative = yamlStat ? "pnpm-workspace.yaml" : ymlStat ? "pnpm-workspace.yml" : undefined;
  const stat = yamlStat ?? ymlStat;
  if (!relative || !stat || stat.isSymbolicLink() || !stat.isFile()) return [];
  const config = parseWorkspaceYaml(readText(root, relative, budget), relative);
  if (config.packages === undefined) return [];
  return stringPatterns(config.packages, relative);
}

function cargoWorkspace(manifest: UnknownRecord, file: string): { members: string[]; exclude: string[] } {
  const workspace = manifest.workspace;
  if (workspace === undefined) return { members: [], exclude: [] };
  if (!isRecord(workspace)) throw new Error(`Project detection found malformed Cargo workspace: ${file}`);
  return {
    members: workspace.members === undefined ? [] : stringPatterns(workspace.members, `${file} workspace.members`),
    exclude: workspace.exclude === undefined ? [] : stringPatterns(workspace.exclude, `${file} workspace.exclude`),
  };
}

function parseJson(contents: string, file: string): UnknownRecord {
  try {
    const value: unknown = JSON.parse(contents);
    if (!isRecord(value)) throw new Error("expected object");
    return value;
  } catch {
    throw new Error(`Project detection found malformed JSON manifest: ${file}`);
  }
}

function parseToml(contents: string, file: string): UnknownRecord {
  try {
    const value: unknown = parseTomlDocument(contents);
    if (!isRecord(value)) throw new Error("expected table");
    return value;
  } catch {
    throw new Error(`Project detection found malformed TOML manifest: ${file}`);
  }
}

function parseWorkspaceYaml(contents: string, file: string): UnknownRecord {
  try {
    const value: unknown = parseYaml(contents);
    if (!isRecord(value)) throw new Error("expected object");
    return value;
  } catch {
    throw new Error(`Project detection found malformed YAML workspace config: ${file}`);
  }
}

function stringPatterns(value: unknown, source: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Project detection workspace paths must be an array of strings: ${source}`);
  }
  if (value.length > MAX_PATTERNS) throw new Error(`Project detection supports at most ${MAX_PATTERNS} workspace paths: ${source}`);
  return value.map((pattern: string) => pattern.startsWith("!")
    ? `!${validatePattern(pattern.slice(1), source)}`
    : validatePattern(pattern, source));
}

function packageWorkspacePatterns(manifest: UnknownRecord, file: string): string[] {
  const workspaces = manifest.workspaces;
  if (workspaces === undefined) return [];
  if (Array.isArray(workspaces)) return stringPatterns(workspaces, file);
  if (isRecord(workspaces)) return stringPatterns(workspaces.packages, file);
  throw new Error(`Project detection found malformed package workspaces: ${file}`);
}

function dependencyNames(value: unknown): string[] {
  return isRecord(value) ? Object.keys(value).map((name) => name.toLowerCase()) : [];
}

function mappedFeatures(dependencies: Iterable<string>, mapping: Readonly<Record<string, string>>): string[] {
  const features = new Set<string>();
  for (const dependency of dependencies) {
    if (!Object.hasOwn(mapping, dependency)) continue;
    const feature = mapping[dependency];
    if (feature) features.add(feature);
  }
  return [...features].sort(lexicalCompare);
}

const JS_FEATURES: Readonly<Record<string, string>> = {
  "@angular/core": "angular",
  "@pinia/nuxt": "pinia",
  "@unocss/vite": "unocss",
  gsap: "gsap",
  next: "next",
  nuxt: "nuxt",
  pinia: "pinia",
  react: "react",
  "react-dom": "react",
  tailwindcss: "tailwindcss",
  "typescript": "typescript",
  turbo: "turbo",
  vite: "vite",
  vitepress: "vitepress",
  vitest: "vitest",
  unocss: "unocss",
  vue: "vue",
};

const PHP_FEATURES: Readonly<Record<string, string>> = {
  "laravel/fortify": "fortify",
  "laravel/framework": "laravel",
  "laravel/wayfinder": "wayfinder",
  "pestphp/pest": "pest",
  "phpunit/phpunit": "phpunit",
  "symfony/framework-bundle": "symfony",
};

const RUST_FEATURES: Readonly<Record<string, string>> = {
  actix: "actix",
  "actix-web": "actix-web",
  anyhow: "anyhow",
  axum: "axum",
  serde: "serde",
  tauri: "tauri",
  tokio: "tokio",
};

function jsFeatures(manifest: UnknownRecord): string[] {
  const deps = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]
    .flatMap((key) => dependencyNames(manifest[key]));
  const features = new Set(mappedFeatures(deps, JS_FEATURES));
  const packageManager = manifest.packageManager;
  if (typeof packageManager === "string" && packageManager.startsWith("pnpm@") && packageManager.slice("pnpm@".length).trim()) {
    features.add("pnpm");
  }
  return [...features].sort(lexicalCompare);
}

function phpFeatures(manifest: UnknownRecord): string[] {
  const deps = [...dependencyNames(manifest.require), ...dependencyNames(manifest["require-dev"])];
  const features = mappedFeatures(deps, PHP_FEATURES);
  if (deps.some((name) => name.startsWith("illuminate/")) && !features.includes("laravel")) features.push("laravel");
  return features.sort(lexicalCompare);
}

function rustDependencies(manifest: UnknownRecord): string[] {
  const deps: string[] = [];
  const addTables = (tables: unknown): void => {
    if (isRecord(tables)) deps.push(...Object.keys(tables).map((name) => name.toLowerCase()));
  };
  addTables(manifest.dependencies);
  addTables(manifest["dev-dependencies"]);
  addTables(manifest["build-dependencies"]);
  if (isRecord(manifest.target)) {
    for (const target of Object.values(manifest.target)) {
      if (!isRecord(target)) continue;
      addTables(target.dependencies);
      addTables(target["dev-dependencies"]);
      addTables(target["build-dependencies"]);
    }
  }
  return deps;
}

function emptyDetection(): ProjectDetection {
  return { stacks: [], features: [], evidence: [], directories: [] };
}

/** Detect stack manifests in root and bounded workspace/convention directories. */
export function detectProject(projectDirectory: string, options?: ProjectDetectionOptions): ProjectDetection {
  const configured = options === undefined ? {} : normalizeOptions(options);
  if (configured.enabled === false) return emptyDetection();

  const root = path.resolve(projectDirectory);
  const scanBudget: ScanBudget = { units: 0, matches: 0 };
  const rootStat = lstatIfPresent(root, ".", scanBudget);
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Project detection root must be a real directory: ${projectDirectory}`);
  }

  const pnpmPatterns = pnpmWorkspacePatterns(root, scanBudget);
  const rootPackage = readManifest(root, ".", "package.json", parseJson, scanBudget);
  const rootComposer = readManifest(root, ".", "composer.json", parseJson, scanBudget);
  const rootCargo = readManifest(root, ".", "Cargo.toml", parseToml, scanBudget);
  const packagePatterns = rootPackage ? packageWorkspacePatterns(rootPackage, "package.json") : [];
  const cargoPatterns = rootCargo ? cargoWorkspace(rootCargo, "Cargo.toml") : { members: [], exclude: [] };

  const pnpmDirectories = workspaceDirectories(root, ".", pnpmPatterns, scanBudget);
  const packageDirectories = workspaceDirectories(root, ".", packagePatterns, scanBudget);
  const cargoDirectories = workspaceDirectories(root, ".", cargoPatterns.members, scanBudget, cargoPatterns.exclude);
  const jsExcludedDirectories = new Set<string>([...pnpmDirectories.excluded, ...packageDirectories.excluded]);
  const rustExcludedDirectories = new Set<string>(cargoDirectories.excluded);
  const pending = new Map<string, boolean>();
  const registered = new Set<string>();
  const addDirectories = (directories: readonly string[]): void => {
    for (const directory of directories) scheduleDirectory(pending, registered, directory, true);
  };
  addDirectories(expandDirectories(root, ["apps/*", "packages/*", "libs/*", "crates/*"], "convention", scanBudget));
  addDirectories(pnpmDirectories.directories);
  addDirectories(packageDirectories.directories);
  addDirectories(cargoDirectories.directories);
  addDirectories(expandDirectories(root, configured.paths ?? [], "options.paths", scanBudget));

  const evidence: ProjectDetection["evidence"] = [];
  if (rootPackage) recordEvidence(evidence, true, "package.json", "js", jsFeatures(rootPackage));
  if (rootComposer) recordEvidence(evidence, true, "composer.json", "php", phpFeatures(rootComposer));
  if (rootCargo && !isExcludedByWorkspace(".", rustExcludedDirectories)) {
    recordEvidence(evidence, true, "Cargo.toml", "rust", mappedFeatures(rustDependencies(rootCargo), RUST_FEATURES));
  }

  const seen = new Set<string>(["."]);
  for (;;) {
    const next = takeNextDirectory(pending);
    if (!next) break;
    const [directory, selected] = next;
    if (seen.has(directory) || !safeDirectory(root, directory, scanBudget)) continue;
    seen.add(directory);

    const packageFile = `${directory}/package.json`;
    const composerFile = `${directory}/composer.json`;
    const cargoFile = `${directory}/Cargo.toml`;
    const jsAllowed = !isExcludedByWorkspace(directory, jsExcludedDirectories);
    const rustAllowed = !isExcludedByWorkspace(directory, rustExcludedDirectories);

    const discoveredPackage = jsAllowed
      ? readManifest(root, directory, "package.json", parseJson, scanBudget)
      : undefined;
    if (discoveredPackage) {
      recordEvidence(evidence, selected, packageFile, "js", jsFeatures(discoveredPackage));
      const declared = packageWorkspacePatterns(discoveredPackage, packageFile);
      const workspaces = workspaceDirectories(root, directory, declared, scanBudget);
      addExcluded(jsExcludedDirectories, workspaces.excluded);
      for (const child of workspaces.directories) scheduleDirectory(pending, registered, child, true);
    }

    if (selected) {
      const discoveredComposer = readManifest(root, directory, "composer.json", parseJson, scanBudget);
      if (discoveredComposer) recordEvidence(evidence, true, composerFile, "php", phpFeatures(discoveredComposer));
    }

    const discoveredCargo = rustAllowed
      ? readManifest(root, directory, "Cargo.toml", parseToml, scanBudget)
      : undefined;
    if (discoveredCargo) {
      const declared = cargoWorkspace(discoveredCargo, cargoFile);
      const workspaces = workspaceDirectories(root, directory, declared.members, scanBudget, declared.exclude);
      addExcluded(rustExcludedDirectories, workspaces.excluded);
      if (selected && !isExcludedByWorkspace(directory, rustExcludedDirectories)) {
        recordEvidence(evidence, true, cargoFile, "rust", mappedFeatures(rustDependencies(discoveredCargo), RUST_FEATURES));
      }
      for (const child of workspaces.directories) scheduleDirectory(pending, registered, child, true);
    }
  }

  evidence.sort((left, right) => lexicalCompare(left.path, right.path) || lexicalCompare(left.stack, right.stack));
  const stacks = [...new Set(evidence.map(({ stack }) => stack))].sort((left, right) => STACK_ORDER.indexOf(left) - STACK_ORDER.indexOf(right));
  const features = [...new Set(evidence.flatMap(({ features: found }) => found))].sort(lexicalCompare);
  const directories = [...new Set(evidence.map(({ path: manifest }) => path.posix.dirname(manifest)))].sort(lexicalCompare);
  return { stacks, features, evidence, directories };
}
