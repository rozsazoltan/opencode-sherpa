import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync, } from "node:fs";
import path from "node:path";
export const SHA256 = /^[a-f0-9]{64}$/u;
export function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNodeError(error) {
    return error instanceof Error && "code" in error;
}
export function lexicalCompare(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
export function hash(value) {
    return createHash("sha256").update(value).digest("hex");
}
export function stableJson(value) {
    if (Array.isArray(value))
        return `[${value.map(stableJson).join(",")}]`;
    if (isRecord(value)) {
        return `{${Object.keys(value).sort(lexicalCompare)
            .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
}
function lstatOptional(target) {
    try {
        return lstatSync(target);
    }
    catch (error) {
        if (isNodeError(error) && error.code === "ENOENT")
            return undefined;
        throw error;
    }
}
function pathSegments(absolutePath) {
    const absolute = path.resolve(absolutePath);
    const root = path.parse(absolute).root;
    return { root, segments: absolute.slice(root.length).split(path.sep).filter(Boolean) };
}
export function inspectPath(target) {
    const { root, segments } = pathSegments(target);
    let current = root;
    let finalStat;
    for (let index = 0; index < segments.length; index++) {
        current = path.join(current, segments[index]);
        const stat = lstatOptional(current);
        if (!stat)
            return undefined;
        if (stat.isSymbolicLink())
            throw new Error(`Symlink path component is not allowed: ${current}`);
        if (index < segments.length - 1 && !stat.isDirectory()) {
            throw new Error(`Path component must be a directory: ${current}`);
        }
        finalStat = stat;
    }
    return finalStat;
}
export function resolveRegularFileTarget(target) {
    const parent = inspectPath(path.dirname(target));
    if (!parent)
        return undefined;
    if (!parent.isDirectory())
        throw new Error(`File parent must be a directory: ${path.dirname(target)}`);
    const entry = lstatOptional(target);
    if (!entry)
        return undefined;
    // Resolve a deliberate config-file link so atomic rename updates its target, not the link itself.
    const resolved = entry.isSymbolicLink() ? realpathSync(target) : target;
    const stat = inspectPath(resolved);
    if (!stat?.isFile())
        throw new Error(`Destination must resolve to a regular file: ${target}`);
    return resolved;
}
export function ensureDirectory(target, mode = 0o700) {
    const { root, segments } = pathSegments(target);
    let current = root;
    for (const segment of segments) {
        current = path.join(current, segment);
        const stat = lstatOptional(current);
        if (!stat) {
            mkdirSync(current, { mode });
            continue;
        }
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            throw new Error(`Directory path contains unsafe component: ${current}`);
        }
    }
}
function assertRegularFile(target) {
    const stat = inspectPath(target);
    if (!stat)
        return false;
    if (!stat.isFile())
        throw new Error(`Destination must be a regular file: ${target}`);
    return true;
}
export function readTextFile(target) {
    if (!assertRegularFile(target))
        return undefined;
    return readFileSync(target, "utf8");
}
export function atomicWrite(target, contents, mode = 0o600) {
    const parent = path.dirname(target);
    ensureDirectory(parent);
    const temporary = path.join(parent, `.${path.basename(target)}.tmp-${randomUUID()}`);
    try {
        writeFileSync(temporary, contents, { flag: "wx", mode });
        renameSync(temporary, target);
    }
    catch (error) {
        try {
            unlinkSync(temporary);
        }
        catch (cleanupError) {
            if (!isNodeError(cleanupError) || cleanupError.code !== "ENOENT")
                throw cleanupError;
        }
        throw error;
    }
}
export function fileMode(target, fallback = 0o644) {
    const stat = inspectPath(target);
    return stat ? Number(stat.mode) & 0o777 : fallback;
}
