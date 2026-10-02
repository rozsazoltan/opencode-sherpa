# opencode-sherpa

OpenCode Sherpa is a project-specific CLI for syncing reusable OpenCode instructions, skills, commands, MCP entries, and OMO-Slim specialist agents. Run it explicitly in each project you want to sync. An optional global V2 plugin can help bootstrap the project-local CLI; it is a convenience, not a replacement for the CLI or the product focus.

## Requirements

- Node.js 22.18 or newer, or Bun
- pnpm
- OpenCode; install OMO-Slim separately if you want specialist-agent sync

The project publishes two AGPL-3.0-or-later npm packages: `@rozsazoltan/opencode-sherpa` for the project CLI and `@rozsazoltan/opencode-sherpa-plugin` for the optional global bootstrap plugin. The CLI launcher loads packaged TypeScript directly with Node.js 22.18+; no generated `dist/` directory or install-time build is required.

Install the CLI in the target project after its first npm release:

```sh
pnpm add @rozsazoltan/opencode-sherpa
pnpm exec sherpa sync
```

Until the initial npm package is published, the pinned GitHub revision remains available:

```sh
pnpm add github:rozsazoltan/opencode-sherpa#e26316eeb7cdf83e6d77090c7aadcd7c13961753
pnpm exec sherpa sync
```

Package installation edits the project's manifest and lockfile and may run dependency lifecycle scripts. Sync materializes selected Sherpa content in that project. It does not install or configure a global plugin.

## Optional global bootstrap plugin

The repository also publishes `@rozsazoltan/opencode-sherpa-plugin`, an optional global bootstrap helper. Install it with OpenCode V2:

```sh
opencode plugin add @rozsazoltan/opencode-sherpa-plugin@latest
```

For local development, load `plugin/sherpa-bootstrap.ts` from an absolute checkout path in the global `plugins` array. The documented V2 configuration accepts absolute paths or `file:` URLs:

```jsonc
{
  "plugins": [
    "/absolute/path/to/opencode-sherpa/plugin/sherpa-bootstrap.ts"
  ]
}
```

Replace the example with the path to your checkout and preserve existing plugin entries. The plugin package is published separately from the CLI package and includes its AGPL license.

In an eligible root session, the plugin offers an opt-in reminder in English. Reply exactly `yes` to approve bootstrap for that project, or `no` to decline. The decision is per project. Approval alone does not install or update anything; invoke `/sherpa-install` or `/sherpa-upgrade` explicitly. Both commands ask the model to use ordinary permissioned OpenCode tools; the plugin does not execute shell commands.

`/sherpa-install` installs the currently pinned revision:

1. `pnpm add github:rozsazoltan/opencode-sherpa#e26316eeb7cdf83e6d77090c7aadcd7c13961753`
2. Only after step 1 succeeds, `pnpm exec sherpa sync`

`/sherpa-upgrade` supports the published scoped CLI package and existing GitHub installs. For an npm dependency, it updates `@rozsazoltan/opencode-sherpa` to the latest version. For a GitHub dependency, it resolves the current `master` commit with `git ls-remote`, validates its 40-character SHA, and updates the dependency to that SHA. It also migrates the legacy unscoped GitHub dependency after the scoped add succeeds:

1. npm dependency: `pnpm update --latest @rozsazoltan/opencode-sherpa`
2. GitHub dependency: `git ls-remote https://github.com/rozsazoltan/opencode-sherpa.git refs/heads/master`, then `pnpm add github:rozsazoltan/opencode-sherpa#<resolved-commit-SHA>`
3. Legacy `opencode-sherpa` dependency: after step 2 succeeds, `pnpm remove opencode-sherpa`
4. Only after required dependency operations succeed, `pnpm exec sherpa sync`

Both commands may change the project manifest and lockfile and may run dependency lifecycle scripts; review and approve those effects. `/sherpa-install` and `/sherpa-upgrade` are plugin commands, not CLI subcommands. The CLI supports `sherpa sync`; there is no `sherpa install` or `sherpa upgrade` command.

The plugin targets the documented OpenCode Plugin API V2 and depends on `@opencode/plugin@2.0.22`. This repository's historical `@opencode-ai/plugin@1.18.34` source is V1; compatibility with every OpenCode V2 runtime has not been verified.

## Release workflow

After the npm packages have their initial public versions and trusted publishers are configured, run the **Prepare release** workflow from the repository's Actions tab. It computes the next UTC `YYYY.MM.N` version from release tags, existing release branches, and both package manifests; creates `chore/release-v<version>` with one automated version-bump commit; and opens `chore: prepare v<version> release`. Related release changes may be added to that PR. Merging a valid release PR publishes both npm packages, creates the matching `v<version>` GitHub release/tag, and deletes the release branch.

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

Create `opencode-sherpa.jsonc` in the repository root. A `.json` file is also accepted, but Sherpa refuses to choose if both exist. Supported settings are `detection`, `agents`, `skills`, `commands`, `instructions`, `agentSources`, `skillSources`, `mcp`, and `language`.

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

The seven original Sherpa skills remain bundled and available only through explicit `skills.include`: `sherpa-php-development`, `sherpa-js-development`, `sherpa-rust-development`, `sherpa-laravel-development`, `sherpa-vue-development`, `sherpa-issue-writing`, and `sherpa-pr-writing`. They are not automatically layered over the curated upstream skills below. Issue/PR-writing skills remain opt-in.

### External skills

`skillSources` configures pinned upstream skill catalogs. It is separate from `agentSources`; OMO-Slim agent sourcing remains unchanged. Omitting `skillSources` enables Sherpa's curated catalog, pinned to immutable upstream commits:

| Namespace | Repository | Automatic selection |
| --- | --- | --- |
| `superpowers` | [`obra/superpowers`](https://github.com/obra/superpowers) | None. Four optional workflow skills: test-driven-development, systematic-debugging, verification-before-completion, and brainstorming. |
| `antfu` | [`antfu/skills`](https://github.com/antfu/skills) | `pnpm` when `packageManager` declares `pnpm@`; `vite`, `vitest`, `vue`, `nuxt`, `pinia`, `unocss`, and `vitepress` when matching manifest dependencies are detected. |
| `nuno` | [`nunomaduro/laravel-starter-kit-inertia-vue`](https://github.com/nunomaduro/laravel-starter-kit-inertia-vue) | Laravel best practices for Laravel projects; Fortify guidance only with `laravel/fortify`; Wayfinder guidance only with `laravel/wayfinder`. |
| `asyraf` | [`AsyrafHussin/agent-skills`](https://github.com/AsyrafHussin/agent-skills) | PHP best practices for detected PHP projects. |
| `leonardomso` | [`leonardomso/rust-skills`](https://github.com/leonardomso/rust-skills) | Rust skills for detected Rust projects. |
| `mattpocock` | [`mattpocock/skills`](https://github.com/mattpocock/skills) | None. Optional diagnosing-bugs, codebase-design, and writing-for-agents skills. |

The `sherpa-antfu-antfu` and `sherpa-antfu-antfu-create-pr` skills are also optional; they contain opinionated policies. Preserve their upstream credits when adapting them. Superpowers prescribes test-first, specification approval, and companion workflows; enable those skills only when those practices fit. Nuno's Fortify and Wayfinder skills do not auto-select from PHP, Vue, React, or Inertia alone. Its Laravel best-practices entry is one canonical skill with its complete rule folder, not duplicate framework copies. No generic JavaScript or TypeScript rule selects a workflow skill. Sherpa uses selected raw skills, not `antfu/skills-pack`'s generator or its third-party catalog.

`skills.auto` defaults to `true`, but only skills with curated matching rules are selected automatically. The original seven Sherpa skills and other uncataloged skills require explicit inclusion. `skills.include` and `skills.exclude` accept IDs from bundled skills and declared upstream entries. Exclusions win. Unknown IDs fail before upstream fetch. Setting `skills.auto` to `false` disables automatic skill selection but keeps explicit includes.

Use `skillSources` as an array to replace the built-in catalog. An empty array disables all external sources; it does not enable automatic fallback to the original Sherpa skills. Explicit includes for those bundled skills still work. The object form appends custom sources by default; set `includeDefaults` to `false` to replace the built-ins:

```jsonc
{
  "skillSources": {
    "includeDefaults": true,
    "sources": [
      {
        "namespace": "team",
        "repository": "example/skills",
        "commit": "0123456789abcdef0123456789abcdef01234567",
        "licensePath": "LICENSE",
        "skills": [
          {
            "id": "release-review",
            "path": "skills/release-review/SKILL.md",
            "supportPaths": ["references"]
          }
        ]
      }
    ]
  }
}
```

Each source requires `namespace`, `repository`, a full immutable `commit` SHA, and one or more `skills`. Specify exactly one source license field: `licensePath` for an actual file in the pinned repository, or `license` for a declared identifier that must match each selected skill's frontmatter. Each skill entry accepts only `id`, exact repository-relative `path`, and optional `supportPaths`. Unknown fields, duplicate namespaces or IDs, mutable refs, globs, absolute paths, traversal segments, and backslashes are rejected. `path` must end in `SKILL.md`. Nested skills copy their containing folder by default; `supportPaths` narrows additional files or directories relative to that skill folder. A root-level `SKILL.md` requires explicit `supportPaths`, including `[]` when it has no supporting files.

Imported IDs use `sherpa-<namespace>-<id>` and remain stable across upstream commit updates. Sherpa preserves the original `SKILL.md` bytes and frontmatter; OpenCode v2 uses frontmatter `name` as the display label. Sherpa fetches only pinned repositories needed by selected skills. It resolves sources through the same integrity-checked archive cache used for agent sources, under `~/.cache/opencode/.sherpa/agent-sources/` or `$XDG_CACHE_HOME/opencode/.sherpa/agent-sources/`. A dry run can fetch over the network, but uses a temporary cache and does not write project files. Source, skill, license, and metadata diagnostics stop sync before project writes.

Skill archives may contain safe relative symlink aliases outside selected skills, support paths, and license files. Sherpa records those aliases in the cache but never extracts or follows them. Links affecting selected content, unsafe paths or targets, hardlinks, and special entries are rejected. Agent-source archives retain strict symlink rejection.

Each imported skill includes deterministic `SHERPA-SOURCE.json` provenance with repository, commit, source path, archive hash, file hashes, and license evidence. Sherpa copies a real pinned license file in full as `SHERPA-LICENSE.txt` when `licensePath` is configured. The Superpowers, Antfu, Asyraf, Leonardomso, and Matt Pocock pins provide MIT license files. Otherwise, provenance records only the declared license identifier; Sherpa does not invent license text or copyright statements. At the built-in Nuno pin, the repository has no root license file; its skill metadata declares MIT and credits Laravel as author. Nuno Maduro distributes those skills; do not attribute their authorship to Nuno. Sherpa's AGPL license covers Sherpa code, not upstream skills; review each upstream license and preserve its notices.

Upstream instructions are not guarantees about the current project or available tools. Antfu references include Vite 8.3.1, Vitest 5.0.1, and pnpm 11/12; verify guidance against local versions. The Nuno Laravel skills include assumptions about the Laravel `search-docs` tool, always using subagents, `Cache::flexible`, and concurrency features; check local Laravel versions and agent tools. Asyraf's PHP 8.0–8.5 guide is community guidance, not official PHP documentation. Leonardomso's guide targets Rust 1.96 and edition 2024; it does not install or upgrade Rust. Copied support scripts and metadata remain inert; syncing does not install tools or provide upstream runtime capabilities.

Automatic commands are `sherpa-js-check`, `sherpa-php-check`, and `sherpa-rust-check`, selected for their detected stacks. They ask the agent to inspect project tooling and run relevant configured checks, not install tools or assume a fixed test command. Invoke a selected command with, for example, `/sherpa-js-check <task>`. The `sherpa-write-issue` and `sherpa-write-pr` commands are opt-in drafting helpers. Selecting a command does not implicitly enable its related skill.

Bundled instruction selection follows the same stack rules: `10-js-development`, `20-php-development`, and `30-rust-development`. The common `00-sherpa-principles` instruction is selected by default for every project. Selected instruction bodies are combined into Sherpa's marked block in root `AGENTS.md`; they do not create separate project instruction files.

All four content settings—`agents`, `skills`, `commands`, and `instructions`—accept `auto`, `include`, and `exclude`. Automatic selection defaults to on, while explicit extras default to empty. Set `auto` to `false` for a manual-only list. `include` adds available IDs, and `exclude` wins over both automatic selection and inclusion. Unknown IDs are errors, not ignored requests. Agent IDs must exist in configured sources; skill IDs must exist in bundled tuning or the active skill-source catalog; commands and instructions must exist in installed tuning content. Command and instruction IDs are relative paths without `.md`, such as `git/status` or `00-sherpa-principles`.

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

Built-in remote MCP entries live in `src/mcp-catalog.ts`. Sync adds project entries only when their names are absent from both the project config and the global config:

- `github` — `https://api.githubcopilot.com/mcp/`
- `jina` — `https://mcp.jina.ai/v1`
- `context7` — `https://mcp.context7.com/mcp`
- `gh_grep` — `https://mcp.grep.app`

For this lookup, Sherpa reads `opencode.json` or `opencode.jsonc` in `$XDG_CONFIG_HOME/opencode` when `XDG_CONFIG_HOME` is absolute, otherwise `~/.config/opencode`. It never writes global configuration, resolves its credential references, or copies its headers into the project. A globally configured name is preserved even when that server is disabled. Ambiguous files or malformed MCP configuration stop sync before project writes. This lookup is not a complete evaluation of every OpenCode configuration layer.

Existing project servers are never replaced or removed. If a name exists both locally and globally, the project server still shadows the entire global server object, including its authentication settings. Sherpa reports that conflict; remove the project entry manually if you want to use the global one. If all catalog entries already exist locally or globally, sync does not create an empty project MCP config.

Sherpa checks for regular credential files under `<global-config-dir>/.secrets` for catalog servers it will add. The filename is the server ID plus `-key`:

```text
github-key
jina-key
context7-key
gh_grep-key
```

When a matching regular file exists, Sherpa writes `oauth: false` and `Authorization: Bearer {file:<absolute-path>}` for that missing server. When it does not exist, Sherpa writes no auth fields; GitHub keeps OpenCode's default OAuth behavior and the other entries remain URL-only. This convention needs no per-server authentication settings or filename overrides. Sherpa checks file metadata only. It never reads, validates, or copies secret contents, including during dry-run. OpenCode resolves the file reference when it loads the project configuration.

The check runs only for catalog entries Sherpa will add; existing global or project servers are left alone. Sherpa generates an absolute reference, not a relative reference such as `{file:./.secrets/github-key}`.

**Migration:** older Sherpa versions embedded token values in generated project headers. Existing entries are preserved, so this update does not automatically remove those values. Replace the old header with a file reference, or remove the project server to use its global definition. If a token was committed or shared, revoke or rotate it.

## Materialized project files

- Root `AGENTS.md`: base rules and selected instructions inside Sherpa's managed block; surrounding user content is preserved.
- `.opencode/skills/`: selected packaged or pinned upstream skills, support files, source provenance, and available upstream license notices.
- `.opencode/commands/`: selected packaged Markdown prompt templates.
- `opencode.json(c)`: missing project MCP entries under `mcp.servers` only.
- `.opencode/oh-my-opencode-slim*`: source-derived project agents, when OMO-Slim is used.
- `.opencode/.sherpa-files.json`: ownership hashes for managed skill and command files, including imported support files and notices.

Tuning content is discovered recursively from the installed package's `tuning/` directory. Discovery does not require a hardcoded file list; curated automatic selection rules are separate:

```text
tuning/
├── instructions/**/*.md
├── skills/<skill-id>/SKILL.md
└── commands/**/*.md
```

Instruction Markdown IDs come from relative paths without `.md`; selected bodies are combined in deterministic path order and written inside Sherpa's marked block in `AGENTS.md`. A bundled skill requires YAML frontmatter `description`; use its directory ID as the frontmatter `name` when authoring Sherpa content. Imported skills retain their original frontmatter and use the namespaced directory ID. Supporting files beside `SKILL.md` are copied with it unless the source descriptor narrows them with `supportPaths`. Uncataloged bundled skills are optional and require an explicit include. Command names come from relative paths (`git/status.md` becomes `/git/status`). Commands are prompt templates, not shell scripts; `$ARGUMENTS` is replaced with entered text. If the placeholder is absent, arguments are appended to the prompt.

The CLI does not intercept runtime permissions. Its former permission hook is removed; OpenCode's configured permission rules remain responsible for access control. The optional global bootstrap plugin is separate from CLI sync and only asks the model to use normal permissioned tools.

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
