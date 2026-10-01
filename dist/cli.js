#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { syncProject } from "./sync.js";
const USAGE = "Usage: sherpa sync [--project <path>] [--dry-run]";
export function parseCliArgs(args, cwd = process.cwd()) {
    if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
        if (args.length > 1)
            throw new Error(USAGE);
        return { projectDirectory: path.resolve(cwd), dryRun: false, help: true };
    }
    if (args[0] !== "sync")
        throw new Error(`Unknown command: ${args[0]}\n${USAGE}`);
    let projectDirectory = cwd;
    let dryRun = false;
    let projectSpecified = false;
    for (let index = 1; index < args.length; index++) {
        const argument = args[index];
        if (argument === "--dry-run") {
            if (dryRun)
                throw new Error("Option --dry-run may only be used once.");
            dryRun = true;
            continue;
        }
        if (argument === "--project") {
            const value = args[index + 1];
            if (!value || value.startsWith("--"))
                throw new Error("Option --project requires a path.");
            if (projectSpecified)
                throw new Error("Option --project may only be used once.");
            projectDirectory = path.resolve(cwd, value);
            projectSpecified = true;
            index++;
            continue;
        }
        throw new Error(`Unknown option: ${argument}\n${USAGE}`);
    }
    return { projectDirectory: path.resolve(projectDirectory), dryRun, help: false };
}
export async function runCli(args, io = {}, dependencies = {}) {
    const stdout = io.stdout ?? ((line) => process.stdout.write(`${line}\n`));
    const stderr = io.stderr ?? ((line) => process.stderr.write(`${line}\n`));
    let parsed;
    try {
        parsed = parseCliArgs(args, io.cwd ?? process.cwd());
    }
    catch (error) {
        stderr(error instanceof Error ? error.message : String(error));
        return 2;
    }
    if (parsed.help) {
        stdout(`${USAGE}\nCommands: sync`);
        return 0;
    }
    try {
        const result = await syncProject({
            projectDirectory: parsed.projectDirectory,
            dryRun: parsed.dryRun,
        }, dependencies);
        for (const message of result.messages)
            stdout(message);
        return 0;
    }
    catch (error) {
        stderr(error instanceof Error ? error.message : String(error));
        return 1;
    }
}
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
    void runCli(process.argv.slice(2)).then((code) => {
        process.exitCode = code;
    });
}
