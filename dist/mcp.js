import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
const GITHUB_URL = "https://api.githubcopilot.com/mcp/";
const JINA_URL = "https://mcp.jina.ai/v1";
const CONTEXT7_URL = "https://mcp.context7.com/mcp";
const GH_GREP_URL = "https://mcp.grep.app";
function validateOptions(options) {
    if (options === undefined)
        return {};
    if (typeof options !== "object" || options === null || Array.isArray(options)) {
        throw new TypeError("MCP options must be an object.");
    }
    const values = options;
    const unsupportedOption = Object.keys(values).find((key) => key !== "githubAuth" && key !== "githubTokenFile");
    if (unsupportedOption)
        throw new TypeError(`Unsupported MCP option: ${unsupportedOption}.`);
    const githubAuth = values.githubAuth;
    if (githubAuth !== undefined && githubAuth !== "oauth" && githubAuth !== "token-file") {
        throw new TypeError("githubAuth must be 'oauth' or 'token-file'.");
    }
    const githubTokenFile = values.githubTokenFile;
    if (githubTokenFile !== undefined) {
        if (typeof githubTokenFile !== "string" || !path.isAbsolute(githubTokenFile)) {
            throw new TypeError("githubTokenFile must be an absolute path.");
        }
        if (githubAuth !== "token-file") {
            throw new TypeError("githubTokenFile requires githubAuth to be 'token-file'.");
        }
    }
    return {
        ...(githubAuth === undefined ? {} : { githubAuth }),
        ...(githubTokenFile === undefined ? {} : { githubTokenFile }),
    };
}
function defaultGithubTokenFile() {
    const xdgConfigHome = process.env.XDG_CONFIG_HOME;
    const configHome = xdgConfigHome && path.isAbsolute(xdgConfigHome)
        ? xdgConfigHome
        : path.join(os.homedir(), ".config");
    return path.join(configHome, "opencode", ".secrets", "github-key");
}
function readGithubToken(tokenFile) {
    let contents;
    try {
        contents = readFileSync(tokenFile, "utf8");
    }
    catch {
        throw new Error("Unable to read GitHub token file.");
    }
    const token = contents.replace(/[\r\n]+$/u, "");
    if (token.trim().length === 0)
        throw new Error("GitHub token file is empty.");
    if (/[\r\n]/u.test(token))
        throw new Error("GitHub token file must contain one line.");
    return token;
}
/** Return default remote MCP entries for merging into project-local OpenCode config. */
export function createRemoteMcpServers(options, existingServers = {}) {
    const validatedOptions = validateOptions(options);
    const useTokenFile = validatedOptions.githubAuth === "token-file";
    const githubToken = useTokenFile && !Object.hasOwn(existingServers, "github")
        ? readGithubToken(validatedOptions.githubTokenFile ?? defaultGithubTokenFile())
        : undefined;
    return {
        github: githubToken === undefined
            ? { type: "remote", url: GITHUB_URL }
            : {
                type: "remote",
                url: GITHUB_URL,
                oauth: false,
                headers: { Authorization: `Bearer ${githubToken}` },
            },
        jina: { type: "remote", url: JINA_URL },
        context7: { type: "remote", url: CONTEXT7_URL },
        gh_grep: { type: "remote", url: GH_GREP_URL },
    };
}
