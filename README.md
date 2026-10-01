# opencode-sherpa

OpenCode Sherpa is a project-oriented CLI for materializing reusable OpenCode instructions, skills, commands, MCP entries, and OMO-Slim specialist agents. It has no OpenCode plugin runtime: run its CLI explicitly when you want to sync a project.

## Requirements

- Node.js 20 or newer
- pnpm
- OpenCode; install OMO-Slim separately if you want specialist-agent sync

Sherpa is installed from GitHub and is not published to the npm registry. Its Node-compatible `dist/` files are committed, so installing the Git dependency does not require a build lifecycle script.

```sh
pnpm add github:rozsazoltan/opencode-sherpa#<tag-or-commit>
pnpm exec opencode-sherpa sync
```

Use a release tag when available, or a commit SHA for a fixed revision. Installing the package does not modify the project; `sync` performs the changes explicitly.

## Commands

```text
opencode-sherpa sync [--project <path>] [--dry-run]
```

The project defaults to the current directory. `--project` accepts an absolute or current-directory-relative path. `--dry-run` prints planned changes without writing project files; it may resolve sources over the network, using a temporary cache.

- `--help` or no arguments prints usage and exits successfully.
- Invalid arguments exit with code 2.
- Sync failures exit with code 1.

Run `sync` again after changing Sherpa's package version, project configuration, or bundled tuning files. Sherpa does not watch files or run automatically at OpenCode startup.

## Project configuration

Create `opencode-sherpa.jsonc` in the project root. A `.json` file is also accepted, but Sherpa refuses to choose if both exist. Only `agentSources`, `mcp`, and `language` are supported.

```jsonc
{
  "language": "hu",
  "mcp": {
    "githubAuth": "oauth"
  }
}
```

### External OMO-Slim agents

By default, Sherpa downloads the pinned [VoltAgent subagent repository](https://github.com/VoltAgent/awesome-claude-code-subagents) and scans selected core-development, language, QA/security, developer-experience, and business/product categories, plus `api-documenter`. It skips README files and derives IDs from source namespace and prompt filename. Claude-specific `tools` and `model` metadata are not carried into OMO-Slim agents.

Sources are immutable repository/commit/directory selections. Add repositories or replace the defaults with `agentSources`:

```jsonc
{
  "agentSources": {
    "includeDefaults": true,
    "sources": [
      {
        "repository": "your-account/agent-prompts",
        "commit": "0123456789abcdef0123456789abcdef01234567",
        "namespace": "personal",
        "directories": ["agents"]
      }
    ]
  }
}
```

Set `includeDefaults` to `false` to use only custom sources. An empty array disables agent sources and removes Sherpa-managed project agents during a successful sync.

Source archives are cached under `~/.cache/opencode/.sherpa/agent-sources/`, or `$XDG_CACHE_HOME/opencode/.sherpa/agent-sources/` when configured. Sherpa verifies cached content and can reuse it offline. Review source prompts and licenses before enabling them; source license and commit provenance are recorded with synchronized prompts.

Agent sync requires OMO-Slim. It updates only project `.opencode/oh-my-opencode-slim.jsonc` (or the sole existing `.json`) and `.opencode/oh-my-opencode-slim/`. It never edits global OMO-Slim config, the main OpenCode config, or global `AGENTS.md`. OMO-Slim must be installed and loaded for the project to use these agents.

**Managed namespace:** each successful sync removes all root and preset agent keys beginning with `sherpa` and all top-level `sherpa*.md` prompts in the project OMO-Slim prompt directory, then recreates them from resolved sources. This intentionally replaces user edits within that prefix. Keep personal agents/prompts outside it. Other entries, prompts, JSONC comments, and settings remain untouched. If any agent source fails validation or cannot be resolved, Sherpa stops before changing project files. Removing Sherpa does not clean generated project files; remove them manually if no longer needed.

### MCP servers

Sync adds these project-level remote MCP entries only when their names are absent:

- `github` — `https://api.githubcopilot.com/mcp/`
- `jina` — `https://mcp.jina.ai/v1`
- `context7` — `https://mcp.context7.com/mcp`
- `gh_grep` — `https://mcp.grep.app`

Existing servers are never replaced. GitHub uses OpenCode-managed OAuth by default. To use a token file instead:

```jsonc
{
  "mcp": {
    "githubAuth": "token-file",
    "githubTokenFile": "/absolute/path/to/github-key"
  }
}
```

`githubTokenFile` must be absolute and contain one line. Without it, Sherpa reads `$XDG_CONFIG_HOME/opencode/.secrets/github-key` or `~/.config/opencode/.secrets/github-key`. When no GitHub MCP entry exists, sync writes the token as an Authorization header in the project OpenCode config. Keep that config out of source control or use OAuth. If a GitHub MCP entry already exists, Sherpa preserves it and does not read the token file.

## Materialized project files

- Root `AGENTS.md`: Sherpa-managed instruction block; surrounding user content is preserved.
- `.opencode/skills/`: packaged skills and their support files.
- `.opencode/commands/`: packaged Markdown prompt templates.
- `opencode.json(c)`: missing project MCP entries under `mcp.servers` only.
- `.opencode/oh-my-opencode-slim*`: source-derived project agents, when OMO-Slim is used.
- `.opencode/.sherpa-files.json`: ownership hashes for managed packaged skill/command files.

Tuning content is discovered recursively from the installed package's `tuning/` directory; filenames are not listed in code:

```text
tuning/
├── instructions/**/*.md
├── skills/<skill-id>/SKILL.md
└── commands/**/*.md
```

Instruction Markdown is combined in deterministic path order and written inside Sherpa's marked block in `AGENTS.md`. A skill requires YAML frontmatter `description`; supporting files beside `SKILL.md` are copied with it. Command names come from relative paths (`git/status.md` becomes `/git/status`). Commands are prompt templates, not shell scripts; `$ARGUMENTS` is replaced with entered text. If the placeholder is absent, arguments are appended to the prompt.

Sherpa does not enforce runtime permissions. The former permission hook is removed; OpenCode's configured permission rules remain responsible for access control.

## Sync behavior and safety

Sherpa validates source resolution and plans project writes before applying them. Source diagnostics abort before project files change. Managed skill/command files are tracked by hashes; user conflicts and modifications are preserved. Existing MCP server names and unrelated JSONC content are preserved. Project writes apply in stages—generated artifacts, MCP config, then OMO-Slim reconciliation—so a failure in a later stage does not roll back earlier stages. Back up project files before first sync and inspect `--dry-run` output.

## Development

```sh
bun install --frozen-lockfile
bun test
bun run typecheck
bun run build
```

`dist/` is committed for pnpm Git installs; run `bun run build` after changing `src/`.

## License

OpenCode Sherpa is licensed under the [GNU Affero General Public License v3.0 or later](LICENSE).
