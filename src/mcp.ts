import path from "node:path";
import { DEFAULT_SHERPA_MCP_CATALOG } from "./mcp-catalog.ts";
import { defaultOpenCodeConfigDirectory } from "./opencode-config.ts";

export interface McpOptions {
  /** Defaults to OpenCode-managed OAuth. */
  readonly githubAuth?: "oauth" | "token-file";
  /** Absolute path override used only with githubAuth: "token-file". */
  readonly githubTokenFile?: string;
}

interface McpRuntimeOptions {
  readonly globalConfigDirectory?: string;
}

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
    validateFileTemplatePath(githubTokenFile, "githubTokenFile");
    if (githubAuth !== "token-file") {
      throw new TypeError("githubTokenFile requires githubAuth to be 'token-file'.");
    }
  }

  return {
    ...(githubAuth === undefined ? {} : { githubAuth }),
    ...(githubTokenFile === undefined ? {} : { githubTokenFile }),
  };
}

function validateFileTemplatePath(filePath: string, name: string): void {
  if (/[\0\r\n{}]/u.test(filePath)) {
    throw new TypeError(`${name} contains characters that cannot be used in an OpenCode file reference.`);
  }
}

function validateRuntimeOptions(options: unknown): McpRuntimeOptions {
  if (options === undefined) return {};
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new TypeError("MCP runtime options must be an object.");
  }

  const values = options as Record<string, unknown>;
  const unsupportedOption = Object.keys(values).find((key) => key !== "globalConfigDirectory");
  if (unsupportedOption) throw new TypeError(`Unsupported MCP runtime option: ${unsupportedOption}.`);

  const globalConfigDirectory = values.globalConfigDirectory;
  if (globalConfigDirectory !== undefined) {
    if (typeof globalConfigDirectory !== "string" || !path.isAbsolute(globalConfigDirectory)) {
      throw new TypeError("globalConfigDirectory must be an absolute path.");
    }
    validateFileTemplatePath(globalConfigDirectory, "globalConfigDirectory");
    return { globalConfigDirectory };
  }

  return {};
}

/** Return default remote MCP entries for merging into project-local OpenCode config. */
export function createRemoteMcpServers(
  options?: McpOptions,
  existingServers: Readonly<Record<string, unknown>> = {},
  runtimeOptions?: McpRuntimeOptions,
): Record<string, unknown> {
  const validatedOptions = validateOptions(options);
  const validatedRuntimeOptions = validateRuntimeOptions(runtimeOptions);
  const useTokenFile = validatedOptions.githubAuth === "token-file";
  const githubTokenFile = useTokenFile && !Object.hasOwn(existingServers, "github")
    ? validatedOptions.githubTokenFile ?? path.join(
        validatedRuntimeOptions.globalConfigDirectory ?? defaultOpenCodeConfigDirectory(),
        ".secrets",
        "github-key",
      )
    : undefined;
  if (githubTokenFile !== undefined) validateFileTemplatePath(githubTokenFile, "GitHub token file path");

  return Object.fromEntries(DEFAULT_SHERPA_MCP_CATALOG.map(({ id, url }) => [
    id,
    id === "github" && githubTokenFile !== undefined
      ? {
          type: "remote",
          url,
          oauth: false,
          headers: { Authorization: `Bearer {file:${githubTokenFile}}` },
        }
      : { type: "remote", url },
  ]));
}
