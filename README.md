# opencode-sherpa

`opencode-sherpa` is a TypeScript ESM plugin for OpenCode. It declares `@opencode/plugin` with the semver range `2`, currently resolved to `2.0.16` by `bun.lock`; this does not assert host-version compatibility.

## What it does today

- Adds session context instructions that use the configured conversation language, while keeping engineering artifacts such as code identifiers, comments, commits, issues, and pull requests in English. Set `options.language` to a language such as `hu`; without a valid value, the plugin does not force a conversation language.
- Handles OpenCode V2's separate `external_directory`, `read`, and `edit` actions. A matching `ask` may be allowed for paths under the default allowed root, `path.join(os.tmpdir(), "opencode")`, or an added `allowDirectories` root. `denyDirectories` takes priority over allowed roots: a matching request is denied even if its previous effect was `allow` when this hook runs. An explicit configured deny is never overridden.
- Registers remote MCP servers `github` (`https://api.githubcopilot.com/mcp/`), `jina` (`https://mcp.jina.ai/v1`), `context7` (`https://mcp.context7.com/mcp`), and `gh_grep` (`https://mcp.grep.app`) only when their names are not already configured, preserving existing entries.
- With explicit `options.hostSync: true`, adds only external plugin selectors to the machine's existing global OpenCode config. This includes your [OpenCode Caveman V2 plugin](https://github.com/rozsazoltan/opencode-caveman), pinned to a reviewed commit, plus Slim/DCP and conditional Playwright. OpenCode loads Caveman; Sherpa does not install, copy, or reimplement its skills, commands, agents, or mode handling.

Sherpa's engineering context instructions remain independent of the Caveman plugin. Caveman modes and their assets are owned by `opencode-caveman`.

The GitHub MCP entry uses OpenCode-managed OAuth by default. OpenCode generally persists OAuth authorization per machine in host-managed storage, but this plugin does not guarantee that this endpoint interoperates with the host OAuth flow or that authentication survives a restart. Those behaviors have not been runtime-verified.

An alternative is to explicitly set `options.mcp.githubAuth` to `"token-file"`. Optionally set `options.mcp.githubTokenFile` to an absolute path; otherwise the token is read from `~/.config/opencode/.secrets/github-key`, or `$XDG_CONFIG_HOME/opencode/.secrets/github-key` when `XDG_CONFIG_HOME` is absolute. Keep the token out of logs and the repository, and restrict access to the file (for example, owner-only permissions such as mode `600` on POSIX systems). This option reads a local token; it does not generate or rotate credentials.

OpenCode V2 plugins cannot install other plugins as nested dependencies. Host sync adds `opencode-caveman`, `oh-my-opencode-slim@2`, and `@tarquinen/opencode-dcp@3` to the global `plugins` list; on Windows/WSL it also adds `opencode-playwright` pinned to a Git commit. OpenCode installs and loads these packages itself after restart; Sherpa does not call their `setup` functions or copy their payloads. Slim's bundled skills then come from Slim. The Playwright bridge requires a compatible Windows browser owner / WSL proxy setup; OS detection alone does not provide those prerequisites or guarantee operation.

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
        "hostSync": true,
        "permissions": {
          "allowDirectories": ["/srv/projects/demo/uploads"],
          "denyDirectories": ["/srv/projects/demo/uploads/private"]
        }
      }
    }
  ]
}
```

This Git package selector is an initial configuration example and has not yet been runtime-verified; confirm support with your OpenCode version before relying on it. `hostSync` defaults to off. Caveman's plugin is pinned to a Git commit in Sherpa's host-sync manifest; update Sherpa and rerun host sync to adopt a newer reviewed plugin commit. Caveman's own upstream content update behavior is documented in its repository.

Turn `hostSync` on only in the global config you intend to manage. Sherpa registers its MCPs at runtime. On first startup host sync adds missing external plugin selectors; restart OpenCode to load those packages in CLI/TUI and desktop. If optional host sync fails, Sherpa keeps its runtime registrations active and logs a warning. When Sherpa is updated, restart it to apply an updated manifest. The Git URL does not auto-replace already installed code; run `opencode plugin update` on each machine when you want a newer Sherpa version. To remove Sherpa, disable `hostSync`, remove its plugin entry, and restart; remove any remaining Sherpa-owned external plugin entries you no longer want.

Sync modifies only a single existing `~/.config/opencode/opencode.json` or `opencode.jsonc` (or the equivalent absolute `$XDG_CONFIG_HOME/opencode/` path); it refuses to guess if both or neither exists, or if the file is invalid or a symlink. It retains unrelated settings and comments (comments attached to removed owned selectors may be removed). A local `.sherpa-owned.json` journal tracks only plugin selectors Sherpa added so future versions may change or remove only unchanged Sherpa-owned entries. Existing selectors are preserved rather than adopted; changing one of Sherpa's entries by hand relinquishes its ownership. Upgrading from the earlier journal format removes its agent and command definitions only when they still exactly match the recorded Sherpa-owned versions; user edits remain untouched. Restart OpenCode once after this migration so the Caveman plugin can register its commands and agents. The journal contains package selectors, not credentials. A temporary `.sherpa-sync.lock` directory serializes concurrent Sherpa runs, and `.sherpa-sync-pending.json` permits recovery from a crash between the config and journal writes. If a crash leaves a stale lock, verify that no sync is running before removing it manually. If an external editor changes files during an interrupted sync, Sherpa refuses automatic recovery rather than overwriting the edits; restore from your backup or resolve the pending state manually. External editors that do not use this lock can still race with a sync, so do not edit the host config during OpenCode startup. Project-level configuration can override global values. Back up your host config before opting in; this is startup-time local file editing, not a sandbox or an all-or-nothing installation transaction.

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
│   ├── host-config.ts
│   ├── instructions.ts
│   ├── mcp.ts
│   └── permissions.ts
└── test/
    ├── host-config.test.ts
    ├── instructions.test.ts
    ├── mcp.test.ts
    ├── permissions.test.ts
    └── plugin.test.ts
```

## Roadmap

Provider integrations and stronger end-to-end verification remain future work. Live OpenCode Git loading, remote OAuth handshakes, native Windows/macOS behavior, external plugin loading, and Playwright bridge prerequisites have not been verified in an OpenCode session.

## License

This project is licensed under the [GNU Affero General Public License v3.0 or later](LICENSE).
