# opencode-sherpa

`opencode-sherpa` is a TypeScript ESM plugin for OpenCode. It declares `@opencode/plugin` with the semver range `2`, currently resolved to `2.0.16` by `bun.lock`; this does not assert host-version compatibility.

## What it does today

- Injects Sherpa's own engineering and conversation-language guidance through OpenCode's session context hook, without writing or managing a global `AGENTS.md`. Set `options.language` to a language such as `hu`; without a valid value, the plugin does not force a conversation language.
- Handles OpenCode V2's separate `external_directory`, `read`, and `edit` actions. A matching `ask` may be allowed for paths under the default allowed root, `path.join(os.tmpdir(), "opencode")`, or an added `allowDirectories` root. `denyDirectories` takes priority over allowed roots: a matching request is denied even if its previous effect was `allow` when this hook runs. An explicit configured deny is never overridden.
- Registers remote MCP servers `github` (`https://api.githubcopilot.com/mcp/`), `jina` (`https://mcp.jina.ai/v1`), `context7` (`https://mcp.context7.com/mcp`), and `gh_grep` (`https://mcp.grep.app`) only when their names are not already configured, preserving existing entries.
Sherpa only manages its own runtime registrations. External plugins such as Caveman, Slim, DCP, and Playwright must be configured directly in OpenCode.

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

The loader reads the packaged Sherpa tree, ignores symbolic links within it, and rejects a symbolic `tuning/` root. It reports invalid skill/command frontmatter during plugin setup instead of silently skipping those definitions. Content files sort by relative path, and Sherpa registers commands in that order. Command name collisions follow OpenCode's transform registration order; its command editor has no collision lookup, so a registration may replace an existing command. Content changes take effect after the plugin is reloaded; with a Git-installed package, update the package first. Sherpa does not package custom agents or create a global `AGENTS.md`.

The GitHub MCP entry uses OpenCode-managed OAuth by default. OpenCode generally persists OAuth authorization per machine in host-managed storage, but this plugin does not guarantee that this endpoint interoperates with the host OAuth flow or that authentication survives a restart. Those behaviors have not been runtime-verified.

An alternative is to explicitly set `options.mcp.githubAuth` to `"token-file"`. Optionally set `options.mcp.githubTokenFile` to an absolute path; otherwise the token is read from `~/.config/opencode/.secrets/github-key`, or `$XDG_CONFIG_HOME/opencode/.secrets/github-key` when `XDG_CONFIG_HOME` is absolute. Keep the token out of logs and the repository, and restrict access to the file (for example, owner-only permissions such as mode `600` on POSIX systems). This option reads a local token; it does not generate or rotate credentials.

OpenCode V2 plugins cannot install other plugins as nested dependencies. Configure external plugin selectors directly in OpenCode's `plugins` list; OpenCode installs and loads them. Sherpa does not edit the host config or install plugins. The Playwright bridge requires a compatible Windows browser owner / WSL proxy setup.

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

This Git package selector is an initial configuration example and has not yet been runtime-verified; confirm support with your OpenCode version before relying on it.

Restart OpenCode after updating the Sherpa plugin package to load the new version. To remove Sherpa, remove its plugin entry and restart OpenCode.

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
│   ├── permissions.ts
│   └── tuning.ts
├── test/
│   ├── instructions.test.ts
│   ├── mcp.test.ts
│   ├── permissions.test.ts
│   ├── plugin.test.ts
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
