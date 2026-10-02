import { statSync } from "node:fs";
import path from "node:path";
import { DEFAULT_SHERPA_MCP_CATALOG } from "./mcp-catalog.ts";
import { defaultOpenCodeConfigDirectory } from "./opencode-config.ts";

export interface McpOptions {
  /** Force OpenCode-managed OAuth for GitHub instead of detecting github-key. */
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

function existingCredentialFile(filePath: string, serverId: string): string | undefined {
  try {
    return statSync(filePath).isFile() ? filePath : undefined;
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? (error as NodeJS.ErrnoException).code
      : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw new Error(`Unable to inspect credential file for MCP server "${serverId}".`);
  }
}

/** Return default remote MCP entries for merging into project-local OpenCode config. */
export function createRemoteMcpServers(
  options?: McpOptions,
  existingServers: Readonly<Record<string, unknown>> = {},
  runtimeOptions?: McpRuntimeOptions,
): Record<string, unknown> {
  const validatedOptions = validateOptions(options);
  const validatedRuntimeOptions = validateRuntimeOptions(runtimeOptions);
  const configDirectory = validatedRuntimeOptions.globalConfigDirectory ?? defaultOpenCodeConfigDirectory();

  return Object.fromEntries(DEFAULT_SHERPA_MCP_CATALOG.map(({ id, url }) => {
    const forceOAuth = id === "github" && validatedOptions.githubAuth === "oauth";
    const credentialPath = Object.hasOwn(existingServers, id) || forceOAuth
      ? undefined
      : id === "github" && validatedOptions.githubAuth === "token-file" && validatedOptions.githubTokenFile
        ? validatedOptions.githubTokenFile
        : path.join(configDirectory, ".secrets", `${id}-key`);
    const existingFile = credentialPath === undefined
      ? undefined
      : existingCredentialFile(credentialPath, id);

    if (existingFile !== undefined) {
      validateFileTemplatePath(existingFile, `${id} credential file path`);
      return [id, {
        type: "remote",
        url,
        oauth: false,
        headers: { Authorization: `Bearer {file:${existingFile}}` },
      }];
    }

    return [id, { type: "remote", url }];
  }));
}
