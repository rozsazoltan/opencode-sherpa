import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyEdits, modify, parse } from "jsonc-parser";
import { atomicWrite, ensureDirectory, hash, inspectPath, isRecord, readTextFile, } from "./agent-files.js";
import { configuredSherpaAgentSources, resolveSherpaAgentSources } from "./agent-sources.js";
import { createEngineeringInstructions } from "./instructions.js";
import { createRemoteMcpServers } from "./mcp.js";
import { reconcileSherpaOmoAgents } from "./omo-agents.js";
import { loadSherpaTuning } from "./tuning.js";
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHERPA_CONFIG_FILES = ["opencode-sherpa.jsonc", "opencode-sherpa.json"];
const OPENCODE_CONFIG_FILES = ["opencode.jsonc", "opencode.json"];
const MANIFEST_PATH = ".opencode/.sherpa-files.json";
const INSTRUCTIONS_BEGIN = "<!-- opencode-sherpa:begin -->";
const INSTRUCTIONS_END = "<!-- opencode-sherpa:end -->";
function parseJsoncObject(source, label) {
    const errors = [];
    const parsed = parse(source, errors, { allowTrailingComma: true });
    if (errors.length > 0)
        throw new Error(`${label} is malformed.`);
    if (!isRecord(parsed))
        throw new Error(`${label} must contain a JSON object.`);
    return parsed;
}
function selectConfigPath(directory, names, label) {
    const existing = names.map((name) => path.join(directory, name))
        .filter((file) => inspectPath(file) !== undefined);
    if (existing.length > 1)
        throw new Error(`Multiple ${label} files exist; refusing to choose: ${existing.join(", ")}`);
    for (const file of existing) {
        if (!inspectPath(file)?.isFile())
            throw new Error(`${label} must be a regular file: ${file}`);
    }
    return existing[0] ?? path.join(directory, names[names.length - 1]);
}
function loadProjectSettings(projectDirectory) {
    const configPath = selectConfigPath(projectDirectory, SHERPA_CONFIG_FILES, "OpenCode Sherpa config");
    const source = readTextFile(configPath);
    if (source === undefined)
        return {};
    const parsed = parseJsoncObject(source, `OpenCode Sherpa config ${configPath}`);
    const unsupported = Object.keys(parsed).find((key) => !["agentSources", "mcp", "language"].includes(key));
    if (unsupported)
        throw new Error(`Unsupported OpenCode Sherpa config option: ${unsupported}.`);
    return parsed;
}
function planMcpConfig(projectDirectory, options) {
    const configPath = selectConfigPath(projectDirectory, OPENCODE_CONFIG_FILES, "OpenCode config");
    const currentContents = readTextFile(configPath);
    const source = currentContents ?? "{}\n";
    const parsed = parseJsoncObject(source, `OpenCode config ${configPath}`);
    if (parsed.mcp !== undefined && !isRecord(parsed.mcp)) {
        throw new Error(`OpenCode config 'mcp' must be an object: ${configPath}`);
    }
    const mcp = isRecord(parsed.mcp) ? parsed.mcp : {};
    if (mcp.servers !== undefined && !isRecord(mcp.servers)) {
        throw new Error(`OpenCode config 'mcp.servers' must be an object: ${configPath}`);
    }
    const existingServers = isRecord(mcp.servers) ? mcp.servers : {};
    const servers = createRemoteMcpServers(options, existingServers);
    let next = source;
    if (!Object.hasOwn(parsed, "mcp")) {
        next = applyEdits(next, modify(next, ["mcp"], {}, {
            formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
        }));
    }
    if (!Object.hasOwn(mcp, "servers")) {
        next = applyEdits(next, modify(next, ["mcp", "servers"], {}, {
            formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
        }));
    }
    for (const [name, server] of Object.entries(servers)) {
        if (Object.hasOwn(existingServers, name))
            continue;
        next = applyEdits(next, modify(next, ["mcp", "servers", name], server, {
            formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
        }));
    }
    if (next === source)
        return undefined;
    return {
        target: configPath,
        relativePath: path.relative(projectDirectory, configPath).split(path.sep).join("/"),
        contents: Buffer.from(next),
        previousContents: currentContents === undefined ? undefined : Buffer.from(currentContents),
    };
}
function instructionsContent(tuning, language) {
    const text = [createEngineeringInstructions(language), ...tuning.instructions]
        .filter((instruction) => instruction.length > 0)
        .join("\n\n");
    return `${INSTRUCTIONS_BEGIN}\n${text}\n${INSTRUCTIONS_END}`;
}
function mergeInstructions(existing, block, file) {
    if (existing === undefined || existing.length === 0)
        return `${block}\n`;
    const beginCount = existing.split(INSTRUCTIONS_BEGIN).length - 1;
    const endCount = existing.split(INSTRUCTIONS_END).length - 1;
    if (beginCount !== endCount || beginCount > 1) {
        throw new Error(`OpenCode Sherpa instruction markers are malformed: ${file}`);
    }
    if (beginCount === 1) {
        const start = existing.indexOf(INSTRUCTIONS_BEGIN);
        const end = existing.indexOf(INSTRUCTIONS_END) + INSTRUCTIONS_END.length;
        return `${existing.slice(0, start)}${block}${existing.slice(end)}`;
    }
    return `${existing.replace(/\s*$/u, "")}\n\n${block}\n`;
}
function collectSkillFiles(tuning) {
    const files = new Map();
    for (const skill of tuning.skills) {
        const sourceRoot = path.dirname(skill.path);
        const targetRoot = path.join(".opencode", "skills", ...skill.id.split("/"));
        const visit = (sourceDirectory, relativeDirectory) => {
            const stat = lstatSync(sourceDirectory);
            if (!stat.isDirectory() || stat.isSymbolicLink()) {
                throw new Error(`Skill source path must be a real directory: ${sourceDirectory}`);
            }
            for (const entry of readdirSync(sourceDirectory, { withFileTypes: true })) {
                const source = path.join(sourceDirectory, entry.name);
                const relative = path.join(relativeDirectory, entry.name);
                if (entry.isSymbolicLink())
                    continue;
                if (entry.isDirectory()) {
                    visit(source, relative);
                    continue;
                }
                const fileStat = lstatSync(source);
                if (!fileStat.isFile())
                    continue;
                const targetRelative = path.join(targetRoot, relative).split(path.sep).join("/");
                files.set(targetRelative, readFileSync(source));
            }
        };
        visit(sourceRoot, "");
    }
    return files;
}
function createDesiredArtifactFiles(tuning, language, projectDirectory) {
    const desired = collectSkillFiles(tuning);
    for (const command of tuning.commands) {
        const target = path.join(".opencode", "commands", ...command.name.split("/")) + ".md";
        desired.set(target.split(path.sep).join("/"), readFileSync(command.path));
    }
    const instructionsPath = path.join(projectDirectory, "AGENTS.md");
    const currentInstructions = readTextFile(instructionsPath);
    const merged = mergeInstructions(currentInstructions, instructionsContent(tuning, language), instructionsPath);
    desired.set("AGENTS.md", Buffer.from(merged));
    return desired;
}
function parseManifest(source, file) {
    if (source === undefined)
        return {};
    let parsed;
    try {
        parsed = JSON.parse(source);
    }
    catch {
        throw new Error(`OpenCode Sherpa file manifest is malformed: ${file}`);
    }
    if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.files)) {
        throw new Error(`OpenCode Sherpa file manifest is malformed: ${file}`);
    }
    const files = {};
    for (const [relative, digest] of Object.entries(parsed.files)) {
        const segments = relative.split("/");
        if ((!relative.startsWith(".opencode/skills/") && !relative.startsWith(".opencode/commands/")) ||
            path.posix.isAbsolute(relative) ||
            segments.some((segment) => !segment || segment === "." || segment === "..") ||
            typeof digest !== "string" || !/^[a-f0-9]{64}$/u.test(digest)) {
            throw new Error(`OpenCode Sherpa file manifest is malformed: ${file}`);
        }
        files[relative] = digest;
    }
    return files;
}
function readBuffer(target) {
    const stat = inspectPath(target);
    if (!stat)
        return undefined;
    if (!stat.isFile())
        throw new Error(`Destination must be a regular file: ${target}`);
    return readFileSync(target);
}
function planArtifacts(projectDirectory, tuning, language) {
    const manifestPath = path.join(projectDirectory, MANIFEST_PATH);
    const manifestSource = readTextFile(manifestPath);
    const previousFiles = parseManifest(manifestSource, manifestPath);
    const desiredFiles = createDesiredArtifactFiles(tuning, language, projectDirectory);
    const nextFiles = {};
    const writes = [];
    const removals = [];
    const conflicts = [];
    const blockedSkillRoots = new Set();
    for (const skill of tuning.skills) {
        const relativeRoot = `.opencode/skills/${skill.id}/`;
        const skillFile = `${relativeRoot}SKILL.md`;
        const contents = desiredFiles.get(skillFile);
        if (!contents)
            continue;
        const current = readBuffer(path.join(projectDirectory, ...skillFile.split("/")));
        const previousHash = previousFiles[skillFile];
        if (current !== undefined && (previousHash === undefined ||
            (hash(current) !== previousHash && hash(current) !== hash(contents)))) {
            blockedSkillRoots.add(relativeRoot);
            conflicts.push(skillFile);
        }
    }
    for (const [relativePath, contents] of desiredFiles) {
        if ([...blockedSkillRoots].some((root) => relativePath.startsWith(root)))
            continue;
        const target = path.join(projectDirectory, ...relativePath.split("/"));
        const previousContents = readBuffer(target);
        const previousHash = previousFiles[relativePath];
        const nextHash = hash(contents);
        if (relativePath === "AGENTS.md") {
            if (!buffersEqual(previousContents, contents)) {
                writes.push({ target, relativePath, contents, previousContents });
            }
            continue;
        }
        if (previousContents === undefined) {
            if (previousHash !== undefined)
                conflicts.push(relativePath);
            writes.push({ target, relativePath, contents, previousContents, });
            nextFiles[relativePath] = nextHash;
            continue;
        }
        const currentHash = hash(previousContents);
        if (previousHash === undefined) {
            if (currentHash !== nextHash)
                conflicts.push(relativePath);
            continue;
        }
        if (currentHash !== previousHash && currentHash !== nextHash) {
            conflicts.push(relativePath);
            continue;
        }
        nextFiles[relativePath] = nextHash;
        if (currentHash !== nextHash)
            writes.push({ target, relativePath, contents, previousContents });
    }
    for (const [relativePath, previousHash] of Object.entries(previousFiles)) {
        if (desiredFiles.has(relativePath))
            continue;
        const target = path.join(projectDirectory, ...relativePath.split("/"));
        const previousContents = readBuffer(target);
        if (previousContents === undefined)
            continue;
        if (hash(previousContents) !== previousHash) {
            conflicts.push(relativePath);
            continue;
        }
        removals.push({ target, relativePath, previousContents });
    }
    const manifestContents = Buffer.from(`${JSON.stringify({ version: 1, files: nextFiles }, null, 2)}\n`);
    if (manifestSource !== manifestContents.toString("utf8")) {
        writes.push({
            target: manifestPath,
            relativePath: MANIFEST_PATH,
            contents: manifestContents,
            previousContents: manifestSource === undefined ? undefined : Buffer.from(manifestSource),
        });
    }
    return { writes, removals, conflicts: [...new Set(conflicts)].sort() };
}
function applyArtifactPlan(plan) {
    const manifestWrite = plan.writes.find(({ relativePath }) => relativePath === MANIFEST_PATH);
    const artifactWrites = plan.writes.filter(({ relativePath }) => relativePath !== MANIFEST_PATH);
    for (const item of [...artifactWrites, ...plan.removals, ...(manifestWrite ? [manifestWrite] : [])]) {
        const current = readBuffer(item.target);
        if (!buffersEqual(current, item.previousContents)) {
            throw new Error(`OpenCode Sherpa destination changed during sync: ${item.target}`);
        }
    }
    for (const write of artifactWrites)
        atomicWrite(write.target, write.contents);
    for (const removal of plan.removals)
        unlinkSync(removal.target);
    if (manifestWrite)
        atomicWrite(manifestWrite.target, manifestWrite.contents);
}
function buffersEqual(left, right) {
    if (left === undefined || right === undefined)
        return left === right;
    return left.equals(right);
}
function applyConfigWrite(write) {
    ensureDirectory(path.dirname(write.target));
    if (!buffersEqual(readBuffer(write.target), write.previousContents)) {
        throw new Error(`OpenCode config changed during sync: ${write.target}`);
    }
    atomicWrite(write.target, write.contents);
}
function printActions(projectDirectory, plan, mcpWrite, omoPaths, dryRun) {
    const prefix = dryRun ? "Would" : "Will";
    const messages = [
        ...plan.writes.map(({ relativePath }) => `${prefix} write ${relativePath}`),
        ...plan.removals.map(({ relativePath }) => `${prefix} remove ${relativePath}`),
        ...(mcpWrite ? [`${prefix} write ${mcpWrite.relativePath}`] : []),
        ...omoPaths.map((file) => `${prefix} update ${path.relative(projectDirectory, file).split(path.sep).join("/")}`),
        ...plan.conflicts.map((file) => `Preserved user file ${file}`),
    ];
    if (messages.length === 0)
        messages.push(dryRun ? "No changes needed." : "Project is up to date.");
    return messages;
}
export async function syncProject(options, dependencies = {}) {
    const projectDirectory = path.resolve(options.projectDirectory);
    const projectStat = inspectPath(projectDirectory);
    if (!projectStat?.isDirectory())
        throw new Error(`OpenCode project path is not a directory: ${projectDirectory}`);
    const settings = loadProjectSettings(projectDirectory);
    const sources = configuredSherpaAgentSources(settings.agentSources);
    const dryRun = options.dryRun === true;
    const resolver = dependencies.resolveSources ?? resolveSherpaAgentSources;
    let temporaryCache;
    let resolution;
    try {
        const resolutionOptions = dryRun && sources.length > 0
            ? (() => {
                temporaryCache = mkdtempSync(path.join(os.tmpdir(), "opencode-sherpa-dry-run-"));
                return { cacheDirectory: temporaryCache };
            })()
            : undefined;
        resolution = await resolver(sources, resolutionOptions);
    }
    finally {
        if (temporaryCache)
            rmSync(temporaryCache, { recursive: true, force: true });
    }
    if (resolution.diagnostics.length > 0) {
        const details = resolution.diagnostics
            .map(({ namespace, code, message }) => `- ${namespace} (${code}): ${message}`)
            .join("\n");
        throw new Error(`Agent source resolution failed; project files were not changed.\n${details}`);
    }
    const tuning = loadSherpaTuning(options.packageRoot ?? dependencies.packageRoot ?? PACKAGE_ROOT);
    const artifactPlan = planArtifacts(projectDirectory, tuning, settings.language);
    const mcpWrite = planMcpConfig(projectDirectory, settings.mcp);
    const omoResult = reconcileSherpaOmoAgents(resolution, { projectDirectory, dryRun: true });
    const messages = printActions(projectDirectory, artifactPlan, mcpWrite, omoResult.changedPaths, dryRun);
    if (!dryRun) {
        applyArtifactPlan(artifactPlan);
        if (mcpWrite)
            applyConfigWrite(mcpWrite);
        reconcileSherpaOmoAgents(resolution, { projectDirectory });
        return {
            messages: messages.map((message) => message.startsWith("Will write ")
                ? message.replace(/^Will write /u, "Wrote ")
                : message.startsWith("Will remove ")
                    ? message.replace(/^Will remove /u, "Removed ")
                    : message.startsWith("Will update ")
                        ? message.replace(/^Will update /u, "Updated ")
                        : message),
        };
    }
    return { messages };
}
