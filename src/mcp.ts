import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { Registration } from "@opencode/plugin/promise/registration";

export interface McpOptions {
  /** Defaults to OpenCode-managed OAuth. */
  readonly githubAuth?: "oauth" | "token-file";
  /** Absolute path override used only with githubAuth: "token-file". */
  readonly githubTokenFile?: string;
}

const GITHUB_URL = "https://api.githubcopilot.com/mcp/";
const JINA_URL = "https://mcp.jina.ai/v1";

function validateOptions(options: unknown): McpOptions {
  if (options === undefined) return {};
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new TypeError("MCP options must be an object.");
  }

  const values = options as Record<string, unknown>;
  const unsupportedOption = Object.keys(values).find(
    (key) => key !== "githubAuth" && key !== "githubTokenFile",
  );
  if (unsupportedOption) throw new TypeError(`Unsupported MCP option: ${unsupportedOption}.`);

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

function defaultGithubTokenFile(): string {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  const configHome = xdgConfigHome && path.isAbsolute(xdgConfigHome)
    ? xdgConfigHome
    : path.join(os.homedir(), ".config");
  return path.join(configHome, "opencode", ".secrets", "github-key");
}

function readGithubToken(tokenFile: string): string {
  let contents: string;
  try {
    contents = readFileSync(tokenFile, "utf8");
  } catch {
    throw new Error("Unable to read GitHub token file.");
  }

  const token = contents.replace(/[\r\n]+$/u, "");
  if (token.trim().length === 0) throw new Error("GitHub token file is empty.");
  if (/[\r\n]/u.test(token)) throw new Error("GitHub token file must contain one line.");
  return token;
}

/** Register GitHub and Jina remote MCP servers without replacing existing entries. */
export async function registerRemoteMcpServers(
  ctx: Pick<Context, "mcp">,
  options?: McpOptions,
): Promise<Registration> {
  const validatedOptions = validateOptions(options);
  const useTokenFile = validatedOptions.githubAuth === "token-file";

  return ctx.mcp.transform((editor) => {
    if (editor.get("github") === undefined) {
      const githubToken = useTokenFile
        ? readGithubToken(validatedOptions.githubTokenFile ?? defaultGithubTokenFile())
        : undefined;
      editor.set("github", githubToken === undefined
        ? { type: "remote", url: GITHUB_URL }
        : {
            type: "remote",
            url: GITHUB_URL,
            oauth: false,
            headers: { Authorization: `Bearer ${githubToken}` },
          });
    }

    if (editor.get("jina") === undefined) {
      editor.set("jina", { type: "remote", url: JINA_URL });
    }
  });
}
