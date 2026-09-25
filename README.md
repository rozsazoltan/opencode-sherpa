# opencode-sherpa

`opencode-sherpa` is a TypeScript ESM plugin for OpenCode. It declares `@opencode/plugin` with the semver range `2`, currently resolved to `2.0.16` by `bun.lock`; this does not assert host-version compatibility.

## What it does today

- Adds session context instructions that use the configured conversation language, while keeping engineering artifacts such as code identifiers, comments, commits, issues, and pull requests in English. Set `options.language` to a language such as `hu`; without a valid value, the plugin does not force a conversation language.
- Handles OpenCode V2's separate `external_directory`, `read`, and `edit` actions. A matching `ask` may be allowed for paths under the default allowed root, `path.join(os.tmpdir(), "opencode")`, or an added `allowDirectories` root. `denyDirectories` takes priority over allowed roots: a matching request is denied even if its previous effect was `allow` when this hook runs. An explicit configured deny is never overridden.
- Registers remote MCP servers `github` (`https://api.githubcopilot.com/mcp/`), `jina` (`https://mcp.jina.ai/v1`), `context7` (`https://mcp.context7.com/mcp`), and `gh_grep` (`https://mcp.grep.app`) only when their names are not already configured, preserving existing entries.
- With explicit `options.cavemanInstall: true`, runs the pinned [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) `v2.7.0` OpenCode installer once in an isolated staging directory. Sherpa publishes its seven skills, six commands, three Cavecrew agents, and `AGENTS.md` under `<global OpenCode config>/.sherpa/caveman/opencode/`, then registers those installed assets through OpenCode V2 transforms. It never runs the upstream installer against your real OpenCode configuration. Without this opt-in, Sherpa does not install or register Caveman features.
- Adapts the installed Caveman content in memory where its Claude-specific instructions cannot run in OpenCode. A V2 session adapter handles `/caveman` and natural-language mode changes independently for each session. The installed `AGENTS.md` style rules enter the model context **only while that session's Caveman mode is active**; `off` leaves ordinary response style unchanged. The upstream V1 plugin is present in the isolated payload but is **not loaded** by OpenCode V2.
- With explicit `options.hostSync: true`, adds only external plugin selectors to the machine's existing global OpenCode config; restart OpenCode to load newly added external plugins.

Sherpa's engineering context instructions are separate from Caveman mode and remain active regardless of the Caveman opt-in. Caveman's physical `AGENTS.md` stays inside the isolated `.sherpa` payload; Sherpa never creates or changes the machine's global `AGENTS.md`.

Caveman snapshots each prompt's mode in OpenCode's message metadata, so a later queued mode change does not alter an earlier turn's retries. If compaction removes the identifiable prompt from a model request, Sherpa skips automatic Caveman rule injection for that request rather than applying a potentially newer mode. Mode defaults live in plugin memory and are not restored after a plugin restart.

The GitHub MCP entry uses OpenCode-managed OAuth by default. OpenCode generally persists OAuth authorization per machine in host-managed storage, but this plugin does not guarantee that this endpoint interoperates with the host OAuth flow or that authentication survives a restart. Those behaviors have not been runtime-verified.

An alternative is to explicitly set `options.mcp.githubAuth` to `"token-file"`. Optionally set `options.mcp.githubTokenFile` to an absolute path; otherwise the token is read from `~/.config/opencode/.secrets/github-key`, or `$XDG_CONFIG_HOME/opencode/.secrets/github-key` when `XDG_CONFIG_HOME` is absolute. Keep the token out of logs and the repository, and restrict access to the file (for example, owner-only permissions such as mode `600` on POSIX systems). This option reads a local token; it does not generate or rotate credentials.

OpenCode V2 plugins cannot install other plugins as nested dependencies. Host sync adds `oh-my-opencode-slim@2` and `@tarquinen/opencode-dcp@3` to the global `plugins` list; on Windows/WSL it also adds `opencode-playwright` pinned to a Git commit. OpenCode installs and loads these packages itself after restart; Sherpa does not call their `setup` functions or copy their payloads. Slim's own bundled skills then come from Slim. The Playwright bridge requires a compatible Windows browser owner / WSL proxy setup; OS detection alone does not provide those prerequisites or guarantee operation.

The Caveman compression skill uses OpenCode's ordinary file tools, requires a safe out-of-tree backup before editing, and preserves upstream compression rules; it does not run upstream's Claude-dependent Python script. Caveman stats only reports measured session usage if the host makes it available—otherwise it reports unavailable, and never guesses savings. Caveman's installed skills, subagents and slash commands work without host sync **when `cavemanInstall` is enabled**. Existing agent and skill names are preserved. Command names already visible when Sherpa registers are skipped, but a later plugin transform may still replace a command; OpenCode V2 does not expose collision-safe command registration. Other local CC Switch skills are not bundled and their sources have not been identified.

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
        "cavemanInstall": true,
        "permissions": {
          "allowDirectories": ["/srv/projects/demo/uploads"],
          "denyDirectories": ["/srv/projects/demo/uploads/private"]
        }
      }
    }
  ]
}
```

This Git package selector is an initial configuration example and has not yet been runtime-verified; confirm support with your OpenCode version before relying on it. Both `hostSync` and `cavemanInstall` default to off. `cavemanInstall` requires Node.js 18 or newer available as `node` when it first runs the pinned installer; it does not run `npx` or download a floating upstream version. The installed files are integrity-checked on subsequent startups and are never silently overwritten, even by a newer Sherpa version. Back up any locally modified payload before deliberately reinstalling a newer pinned version; Sherpa has no automatic Caveman upgrade or uninstall operation. If the opt-in installation fails, plugin setup reports the error rather than falling back to different Caveman assets.

Turn `hostSync` on only in the global config you intend to manage. Sherpa registers its MCPs when it loads, and Caveman assets when separately opted in. On first startup host sync adds missing external plugin selectors; restart OpenCode to load those packages in CLI/TUI and desktop. If optional host sync fails, Sherpa keeps its runtime registrations active and logs a warning. When Sherpa is updated, restart it to apply an updated manifest. The Git URL does not auto-replace already installed code; run `opencode plugin update` on each machine when you want a newer Sherpa version. To remove Sherpa, disable `hostSync`, remove its plugin entry, and restart; remove any remaining Sherpa-owned external plugin entries you no longer want.

Sync modifies only a single existing `~/.config/opencode/opencode.json` or `opencode.jsonc` (or the equivalent absolute `$XDG_CONFIG_HOME/opencode/` path); it refuses to guess if both or neither exists, or if the file is invalid or a symlink. It retains unrelated settings and comments (comments attached to removed owned selectors may be removed). A local `.sherpa-owned.json` journal tracks only plugin selectors Sherpa added so future versions may change or remove only unchanged Sherpa-owned entries. Existing selectors are preserved rather than adopted; changing one of Sherpa's entries by hand relinquishes its ownership. Upgrading from the earlier journal format removes its agent and command definitions only when they still exactly match the recorded Sherpa-owned versions; user edits remain untouched. Restart OpenCode once after this migration so the runtime commands replace any removed host definitions. The journal contains package selectors, not credentials. A temporary `.sherpa-sync.lock` directory serializes concurrent Sherpa runs, and `.sherpa-sync-pending.json` permits recovery from a crash between the config and journal writes. If a crash leaves a stale lock, verify that no sync is running before removing it manually. If an external editor changes files during an interrupted sync, Sherpa refuses automatic recovery rather than overwriting the edits; restore from your backup or resolve the pending state manually. External editors that do not use this lock can still race with a sync, so do not edit the host config during OpenCode startup. Project-level configuration can override global values. Back up your host config before opting in; this is startup-time local file editing, not a sandbox or an all-or-nothing installation transaction.

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
│   ├── agents.ts
│   ├── caveman-install.ts
│   ├── caveman-mode.ts
│   ├── commands.ts
│   ├── host-config.ts
│   ├── instructions.ts
│   ├── mcp.ts
│   ├── permissions.ts
│   └── skills.ts
└── test/
    ├── agents.test.ts
    ├── caveman-install.test.ts
    ├── caveman-mode.test.ts
    ├── commands.test.ts
    ├── host-config.test.ts
    ├── instructions.test.ts
    ├── mcp.test.ts
    ├── permissions.test.ts
    ├── plugin.test.ts
    └── skills.test.ts
```

## Roadmap

Provider integrations and stronger end-to-end verification remain future work. Live OpenCode Git loading, remote OAuth handshakes, native Windows/macOS behavior, Playwright bridge prerequisites, and full interactive Caveman workflows have not been verified in an OpenCode session; isolated installer and runtime-hook tests do not prove these host behaviors.

## License

This project is licensed under the [GNU Affero General Public License v3.0 or later](LICENSE).
