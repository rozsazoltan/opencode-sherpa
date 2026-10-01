# opencode-sherpa

OpenCode Sherpa is a project-oriented CLI for materializing reusable OpenCode instructions, skills, commands, MCP entries, and OMO-Slim specialist agents. It has no OpenCode plugin runtime: run its CLI explicitly when you want to sync a project.

## Requirements

- Node.js 22.18 or newer, or Bun
- pnpm
- OpenCode; install OMO-Slim separately if you want specialist-agent sync

Sherpa is installed from GitHub and is not published to the npm registry. A small JavaScript launcher loads the packaged TypeScript source with Node.js 22.18+; no generated `dist/` directory or install-time build is required.

```sh
pnpm add github:rozsazoltan/opencode-sherpa#<tag-or-commit>
pnpm exec sherpa sync
```

Use a release tag when available, or a commit SHA for a fixed revision. Installing the package does not modify the project; `sync` performs the changes explicitly.

## Commands

```text
sherpa sync [--project <path>] [--dry-run]
```

The project defaults to the current directory. `--project` accepts an absolute or current-directory-relative path. `--dry-run` prints planned changes without writing project files; it may resolve sources over the network, using a temporary cache.

- `--help` or no arguments prints usage and exits successfully.
- Invalid arguments exit with code 2.
- Sync failures exit with code 1.

Run `sync` again after changing Sherpa's package version, project configuration, or bundled tuning files. Sherpa does not watch files or run automatically at OpenCode startup.

## Project configuration

Create `opencode-sherpa.jsonc` in the repository root. A `.json` file is also accepted, but Sherpa refuses to choose if both exist. Supported settings are `detection`, `agents`, `skills`, `commands`, `instructions`, `agentSources`, `mcp`, and `language`.

```jsonc
{
  "language": "hu",
  "agents": {
    "auto": true,
    "include": ["sherpa-voltagent-api-documenter"],
    "exclude": []
  },
  "skills": {
    "auto": true,
    "include": ["sherpa-issue-writing", "sherpa-pr-writing"],
    "exclude": []
  },
  "commands": {
    "auto": true,
    "include": ["sherpa-write-issue", "sherpa-write-pr"],
    "exclude": []
  },
  "mcp": {
    "githubAuth": "oauth"
  }
}
```

### Repository detection and content selection

Run `sherpa sync` from the repository root, or pass that root with `--project`. Sherpa detects PHP, JavaScript/TypeScript, and Rust from `composer.json`, `package.json`, and `Cargo.toml`. One manifest match enables the corresponding stack across the repository; discovery continues so mixed-language monorepos receive all matching stack content.

Discovery checks root manifests, workspace declarations, and shallow `apps/*`, `packages/*`, `libs/*`, and `crates/*` directories. It reads pnpm workspace patterns, package.json workspaces, and Cargo workspace members. It skips dependency/build/cache directories and linked paths, and limits discovery depth and results. It does not recursively crawl every repository directory. `turbo.json` task definitions are not workspace membership declarations.

Patterns support literal segments, `*`, `?`, and whole-segment `**`; braces, character classes, extglobs, absolute paths, and traversal segments are rejected. Workspace exclusions override convention and explicit-path discovery for their ecosystem: a JavaScript exclusion does not hide PHP or Rust manifests in that directory. Discovery depth is bounded to 10 levels; patterns requiring deeper paths are rejected. Sync fails when discovery exceeds 5,000 matched or configured directories, 128 paths per declaration, or 20,000 shared filesystem entry/read units. Nonmatching entries and repeated scans consume that budget too.

Sherpa accepts `pnpm-workspace.yaml` or `pnpm-workspace.yml` as discovery input and refuses an ambiguous pair. Use `pnpm-workspace.yaml` for pnpm itself; Sherpa's `.yml` support does not imply pnpm accepts that filename. Add relative paths or directory glob patterns for another layout:

```jsonc
{
  "detection": {
    "enabled": true,
    "paths": ["services/*"]
  }
}
```

Set `detection.enabled` to `false` to disable discovery. Explicit content includes still work. Malformed manifests or invalid selection settings stop sync rather than silently selecting the wrong content.

Automatic agents are curated roles matched against discovered source prompts: PHP Pro, JavaScript Pro, Rust Engineer, and detected TypeScript, Laravel, Vue, or React specialists. Other roles remain optional. Agent IDs retain their source namespace; custom repositories can supply the same roles without hardcoded agent IDs.

Automatic skills are original Sherpa coding playbooks: `sherpa-php-development`, `sherpa-js-development`, `sherpa-rust-development`, plus `sherpa-laravel-development` and `sherpa-vue-development` when those frameworks are detected. The issue/PR-writing skills are optional and never enabled automatically. These are bundled guidance, not copies of third-party skill collections or installs of the tools they describe.

Automatic commands are `sherpa-js-check`, `sherpa-php-check`, and `sherpa-rust-check`, selected for their detected stacks. They ask the agent to inspect project tooling and run relevant configured checks, not install tools or assume a fixed test command. Invoke a selected command with, for example, `/sherpa-js-check <task>`. The `sherpa-write-issue` and `sherpa-write-pr` commands are opt-in drafting helpers. Selecting a command does not implicitly enable its related skill.

Bundled instruction selection follows the same stack rules: `10-js-development`, `20-php-development`, and `30-rust-development`. The common `00-sherpa-principles` instruction is selected by default for every project. Selected instruction bodies are combined into Sherpa's marked block in root `AGENTS.md`; they do not create separate project instruction files.

All four content settings—`agents`, `skills`, `commands`, and `instructions`—accept `auto`, `include`, and `exclude`. Automatic selection defaults to on, while explicit extras default to empty. Set `auto` to `false` for a manual-only list. `include` adds available IDs, and `exclude` wins over both automatic selection and inclusion. Unknown IDs are errors, not ignored requests. Agent IDs must exist in configured sources; other IDs must exist in the installed package's tuning content. Command and instruction IDs are relative paths without `.md`, such as `git/status` or `00-sherpa-principles`.

For example, keep only the common bundled instruction:

```jsonc
{
  "instructions": {
    "auto": false,
    "include": ["00-sherpa-principles"]
  }
}
```

Sherpa's base language and code-writing rules remain in the managed block even when all bundled instructions are disabled. Uncataloged bundled commands and instructions are optional and require an explicit include, just like uncataloged skills.

`sherpa sync --dry-run` reports detected stacks, framework features, manifest evidence, selected IDs, reasons, and planned file changes. Nothing is enabled globally or loaded by every agent automatically: project skills remain on-demand OpenCode skills.

### External OMO-Slim agents

By default, Sherpa downloads the pinned [VoltAgent subagent repository](https://github.com/VoltAgent/awesome-claude-code-subagents) and scans selected core-development, language, QA/security, developer-experience, and business/product categories, plus `api-documenter`. Scanning makes those roles available; only stack-matched or explicitly included agents are synchronized. It skips README files and derives IDs from source namespace and prompt filename. Claude-specific `tools` and `model` metadata are not carried into OMO-Slim agents.

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

Set `includeDefaults` to `false` to use only custom sources. Set `agentSources` to `[]` to disable all agent sources and remove Sherpa-managed project agents during a successful sync.

Source archives are cached under `~/.cache/opencode/.sherpa/agent-sources/`, or `$XDG_CACHE_HOME/opencode/.sherpa/agent-sources/` when configured. Sherpa verifies cached content and can reuse it offline. Review source prompts and licenses before enabling them; source license and commit provenance are recorded with synchronized prompts.

Agent sync requires OMO-Slim. It updates only project `.opencode/oh-my-opencode-slim.jsonc` (or the sole existing `.json`) and `.opencode/oh-my-opencode-slim/`. It never edits global OMO-Slim config, the main OpenCode config, or global `AGENTS.md`. OMO-Slim must be installed and loaded for the project to use these agents.

**Managed namespace:** each successful sync removes all root and preset agent keys beginning with `sherpa` and all top-level `sherpa*.md` prompts in the project OMO-Slim prompt directory, then recreates the selected agents. This intentionally replaces user edits within that prefix. Keep personal agents/prompts outside it. Other entries, prompts, JSONC comments, and settings remain untouched. If any agent source fails validation or cannot be resolved, Sherpa stops before changing project files. Removing Sherpa does not clean generated project files; remove them manually if no longer needed.

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

- Root `AGENTS.md`: base rules and selected instructions inside Sherpa's managed block; surrounding user content is preserved.
- `.opencode/skills/`: selected packaged skills and their support files.
- `.opencode/commands/`: selected packaged Markdown prompt templates.
- `opencode.json(c)`: missing project MCP entries under `mcp.servers` only.
- `.opencode/oh-my-opencode-slim*`: source-derived project agents, when OMO-Slim is used.
- `.opencode/.sherpa-files.json`: ownership hashes for managed packaged skill/command files.

Tuning content is discovered recursively from the installed package's `tuning/` directory. Discovery does not require a hardcoded file list; curated automatic selection rules are separate:

```text
tuning/
├── instructions/**/*.md
├── skills/<skill-id>/SKILL.md
└── commands/**/*.md
```

Instruction Markdown IDs come from relative paths without `.md`; selected bodies are combined in deterministic path order and written inside Sherpa's marked block in `AGENTS.md`. A skill requires YAML frontmatter `description`; use its directory ID as the frontmatter `name`. Supporting files beside `SKILL.md` are copied with it. Uncataloged bundled skills are optional and require an explicit include. Command names come from relative paths (`git/status.md` becomes `/git/status`). Commands are prompt templates, not shell scripts; `$ARGUMENTS` is replaced with entered text. If the placeholder is absent, arguments are appended to the prompt.

Sherpa does not enforce runtime permissions. The former permission hook is removed; OpenCode's configured permission rules remain responsible for access control.

## Sync behavior and safety

Sherpa validates detection, selection, and source resolution and plans project writes before applying them. Source diagnostics abort before project files change. Managed skill/command files are tracked by hashes; user conflicts and modifications are preserved. When selection or package contents change, obsolete files are removed only if their contents still match the recorded ownership hash. Modified files remain with a conflict message. Existing MCP server names and unrelated JSONC content are preserved; sync does not remove stale MCP entries. Project writes apply in stages—generated artifacts, MCP config, then OMO-Slim reconciliation—so a failure in a later stage does not roll back earlier stages. Back up project files before first sync and inspect `--dry-run` output.

## Development

```sh
bun install --frozen-lockfile
bun test
bun run typecheck
```

The installed CLI starts from `bin/sherpa.js`. Its Node shebang requires Node.js 22.18 or newer when invoked through pnpm. The launcher strips types only from Sherpa's own source, avoiding Node's restriction on TypeScript entrypoints under `node_modules`. Bun can run `bin/sherpa.js` or `src/cli.ts` directly without that loader.

Node may report its type-stripping API as experimental. Sherpa does not suppress that runtime warning.

## License

OpenCode Sherpa is licensed under the [GNU Affero General Public License v3.0 or later](LICENSE).
