export interface SherpaMcpCatalogEntry {
  readonly id: string;
  readonly url: string;
}

export const DEFAULT_SHERPA_MCP_CATALOG: readonly SherpaMcpCatalogEntry[] = [
  { id: "github", url: "https://api.githubcopilot.com/mcp/" },
  { id: "jina", url: "https://mcp.jina.ai/v1" },
  { id: "context7", url: "https://mcp.context7.com/mcp" },
  { id: "gh_grep", url: "https://mcp.grep.app" },
];
