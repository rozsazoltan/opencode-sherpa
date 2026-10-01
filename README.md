# opencode-sherpa

`opencode-sherpa` is a TypeScript ESM plugin for OpenCode. It declares `@opencode/plugin` with the semver range `2`, currently resolved to `2.0.16` by `bun.lock`; this does not assert host-version compatibility.

## What it does today

- Injects Sherpa's own engineering and conversation-language guidance through OpenCode's session context hook, without writing or managing a global `AGENTS.md`. Set `options.language` to a language such as `hu`; without a valid value, the plugin does not force a conversation language.
- Handles OpenCode V2's separate `external_directory`, `read`, and `edit` actions. A matching `ask` may be allowed for paths under the default allowed root, `path.join(os.tmpdir(), "opencode")`, or an added `allowDirectories` root. `denyDirectories` takes priority over allowed roots: a matching request is denied even if its previous effect was `allow` when this hook runs. An explicit configured deny is never overridden.
- Registers remote MCP servers `github` (`https://api.githubcopilot.com/mcp/`), `jina` (`https://mcp.jina.ai/v1`), `context7` (`https://mcp.context7.com/mcp`), and `gh_grep` (`https://mcp.grep.app`) only when their names are not already configured, preserving existing entries.
- Resolves agent prompts from pinned Git repositories into a shared cache, then reconciles discovered agents in the current project's OMO-Slim config and prompt directory. Sherpa preserves unrelated project entries and files; it never changes global OMO-Slim files or the main OpenCode config, and it does not install OMO-Slim.

## Bundled tuning content

Sherpa discovers its own Markdown content below `tuning/` at plugin startup. You do not list filenames in the plugin configuration or loader code. Add content to the folder matching its purpose:

```text
tuning/
├── instructions/
│   ├── 00-core.md
│   └── workflow/review.md
├── skills/
│   └── code-review/
│       ├── SKILL.md
│       └── references/checklist.md
└── commands/
    ├── review.md
    └── git/status.md
```

- Every Markdown file under `tuning/instructions/` is read recursively and appended to Sherpa's built-in instructions for each model context request. Files are combined in deterministic, relative-path order; numeric prefixes such as `00-` and `10-` make the intended order clear. Keep this directory for short, generally applicable rules because all of it is sent with every request. These are not written to a global `AGENTS.md`.
- Each `tuning/skills/<skill-id>/SKILL.md` is registered as an individual OpenCode skill. Use YAML frontmatter with a `description` (required), optional `name`, and optional `autoinvoke` boolean; the Markdown body is the skill content. Nested directories are supported and form slash-separated IDs. Supporting files can live beside `SKILL.md`. If an ID already exists, Sherpa keeps the existing skill and skips the packaged definition.

  ```md
  ---
  name: Code Review
  description: Review a change for correctness and missing tests.
  autoinvoke: false
  ---

  Inspect the requested change and report actionable findings.
  ```

- Each Markdown file under `tuning/commands/` becomes a separate slash command. Its relative path (without `.md`) is the command name, so `git/status.md` becomes `/git/status`. Optional YAML frontmatter supports only `description`; other fields are rejected. The body is a prompt template, not a shell script. Sherpa replaces every literal `$ARGUMENTS` with all entered arguments; it does not support positional arguments or shell interpolation. If the template has no placeholder, non-empty arguments are appended after a blank line.

  ```md
  ---
  description: Review supplied files for correctness.
  ---

  Review $ARGUMENTS and report actionable findings.
  ```

## OMO-Slim specialist agents

Sherpa resolves agent prompts from pinned GitHub repositories at startup. The default source is [VoltAgent's subagent repository](https://github.com/VoltAgent/awesome-claude-code-subagents), pinned to an immutable commit. Sherpa recursively scans core-development, language-specialist, quality/security, developer-experience, and business/product categories, plus only `api-documenter.md` from specialized domains. README files are skipped. Agent IDs use the source namespace and prompt filename, such as `sherpa-voltagent-javascript-pro`; parent-directory context is added only when filenames collide. No per-agent registry is required.

Use `agentSources` to add repositories and roots or replace defaults. Each source descriptor requires a repository, full commit SHA, namespace, and selected directories. Set `includeDefaults: false` to use only custom sources, or pass an empty array to remove project-local Sherpa agents at startup.

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

Sherpa caches each immutable repository under `~/.cache/opencode/.sherpa/agent-sources/` (or `$XDG_CACHE_HOME/opencode/.sherpa/agent-sources/`) and reuses verified content offline. It downloads GitHub source archives, not mutable branches. Prompt YAML frontmatter may provide `description` and `orchestratorPrompt`; Claude-specific `tools` and `model` fields are ignored. On first successful resolution, source license text is recorded in the project-local OMO-Slim prompt directory with commit and archive-hash provenance; an existing notice file is preserved. Review third-party source content before enabling it.

OMO-Slim must be installed and configured. At each plugin startup, Sherpa reconciles the current project in `.opencode/oh-my-opencode-slim.jsonc` and `.opencode/oh-my-opencode-slim/`; if only `.json` exists, Sherpa uses that file. New agents inherit the active session model in `codex` and `session` presets. OMO-Slim uses descriptions and `orchestratorPrompt` for semantic routing; reload OpenCode/OMO-Slim after startup.

Sherpa-managed namespace is destructive by design: startup removes every project-local root `agents` key and every preset agent key that starts with `sherpa`, then regenerates agents resolved from configured sources. It also removes top-level `sherpa*.md` agent prompt files before writing current prompts. This includes user-modified entries and prompts. Keep user-managed agents and prompts outside this prefix. Sherpa preserves other config entries, JSONC comments, presets, models, and prompt-directory files. It never reads or writes global OMO-Slim config/prompts. Any source-resolution diagnostic, including a failed fetch, skips reconciliation and retains last working agents; an intentionally empty `agentSources` list has no diagnostics and removes all project-local Sherpa-managed agents and prompts. Symlinked config/prompt paths fail safely. Removing the plugin does not clean project files automatically.

Project detection and project-specific skill selection are not implemented yet. Skills remain the bundled definitions in `tuning/skills/`.

The tuning loader reads the packaged Sherpa tree, ignores symbolic links within it, and rejects a symbolic `tuning/` root. It reports invalid skill/command frontmatter during plugin setup instead of silently skipping those definitions. Content files sort by relative path, and Sherpa registers commands in that order. Duplicate names derived from bundled command files fail during loading. Collisions with existing OpenCode commands follow transform registration order; the command editor has no collision lookup, so a registration may replace an existing command. Content changes take effect after the plugin is reloaded; with a Git-installed package, update the package first. Sherpa does not manage global `AGENTS.md`.

The GitHub MCP entry uses OpenCode-managed OAuth by default. OpenCode generally persists OAuth authorization per machine in host-managed storage, but this plugin does not guarantee that this endpoint interoperates with the host OAuth flow or that authentication survives a restart. Those behaviors have not been runtime-verified.

An alternative is to explicitly set `options.mcp.githubAuth` to `"token-file"`. Optionally set `options.mcp.githubTokenFile` to an absolute path; otherwise the token is read from `~/.config/opencode/.secrets/github-key`, or `$XDG_CONFIG_HOME/opencode/.secrets/github-key` when `XDG_CONFIG_HOME` is absolute. Keep the token out of logs and the repository, and restrict access to the file (for example, owner-only permissions such as mode `600` on POSIX systems). This option reads a local token; it does not generate or rotate credentials.

Directory lists accept absolute, literal paths only: no relative paths, globs, or environment-variable interpolation. The default root is computed on the machine running OpenCode, so it adapts to Linux, macOS, and Windows. Additional roots are specific to that machine. Exclusions apply to recognized absolute literal resources and simple terminal `/*` directory patterns; other resource forms retain the host decision. A denied child also denies a directory gate covering its parent, so a broad parent approval may stop working rather than grant partial access. This is permission automation, not a comprehensive AI file-access blocker: the plugin does not auto-allow shell or `bash` actions, but `external_directory` is also the shared gate for shell access, so shell may still access an allowed directory when otherwise permitted. Host shell access is not sandboxed here; symlinks and archive traversal are not fully protected, and this does not guarantee that permission prompts will be eliminated.

## Install

Add the following entry to your per-machine global OpenCode `opencode.jsonc` configuration. The POSIX paths below are examples; replace them with absolute paths on the machine running OpenCode:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-sherpa@git+https://github.com/rozsazoltan/opencode-sherpa.git",
      "options": {
        "language": "hu",
        "permissions": {
          "allowDirectories": ["/srv/projects/demo/uploads"],
          "denyDirectories": ["/srv/projects/demo/uploads/private"]
        }
      }
    }
  ]
}
```

This Git package selector is an initial configuration example and has not yet been runtime-verified; confirm support with your OpenCode version before relying on it. The first startup needs network access to resolve uncached Git sources; later startups can reuse verified cache entries.

Restart OpenCode after updating the Sherpa plugin package to load the new version. To remove Sherpa, remove its plugin entry and restart OpenCode. Sherpa leaves project-local OMO-Slim entries and prompts in place when the plugin is removed; remove them manually if no longer wanted.

To opt into local GitHub token-file authentication instead of the default host-managed OAuth, add this to the Sherpa entry's `options` object:

```jsonc
"mcp": {
  "githubAuth": "token-file",
  "githubTokenFile": "/absolute/path/to/github-key"
}
```

Omit `githubTokenFile` to use the default path above. Never put the token value itself in configuration, documentation, or source control.

## Development

With Bun available, run the test suite and TypeScript type check with:

```sh
bun test
bun run typecheck
```

## Repository layout

```text
.
├── .gitignore
├── bun.lock
├── LICENSE
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts
│   ├── instructions.ts
│   ├── mcp.ts
│   ├── omo-agents.ts
│   ├── permissions.ts
│   └── tuning.ts
├── test/
│   ├── instructions.test.ts
│   ├── mcp.test.ts
│   ├── permissions.test.ts
│   ├── plugin.test.ts
│   ├── omo-agents.test.ts
│   └── tuning.test.ts
└── tuning/
    ├── instructions/
    │   └── 00-sherpa-principles.md
    ├── skills/
    │   └── .gitkeep
    └── commands/
        └── .gitkeep
```

## Roadmap

Provider integrations and stronger end-to-end verification remain future work. Live OpenCode Git loading, remote OAuth handshakes, and native Windows/macOS behavior have not been verified in an OpenCode session.

## License

This project is licensed under the [GNU Affero General Public License v3.0 or later](LICENSE).
