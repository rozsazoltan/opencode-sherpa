# opencode-sherpa

`opencode-sherpa` is a TypeScript ESM plugin for OpenCode. It declares `@opencode/plugin` with the semver range `2`, currently resolved to `2.0.16` by `bun.lock`; this does not assert host-version compatibility.

## What it does today

- Adds session context instructions that use the configured conversation language, while keeping engineering artifacts such as code identifiers, comments, commits, issues, and pull requests in English. Set `options.language` to a language such as `hu`; without a valid value, the plugin does not force a conversation language.
- Handles OpenCode V2's separate `external_directory`, `read`, and `edit` actions. A matching `ask` may be allowed for paths under the default allowed root, `path.join(os.tmpdir(), "opencode")`, or an added `allowDirectories` root. `denyDirectories` takes priority over allowed roots: a matching request is denied even if its previous effect was `allow` when this hook runs. An explicit configured deny is never overridden.
- Registers remote MCP servers named `github` (`https://api.githubcopilot.com/mcp/`) and `jina` (`https://mcp.jina.ai/v1`) only when those names are not already configured, preserving existing entries.
- Registers three independently usable skills from the pinned [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) Git dependency at its `v2.7.0` commit: `caveman`, `caveman-commit`, and `caveman-review`. No per-skill manual installation is needed; registration skips names that already exist.

The context instructions are runtime instructions, similar in purpose to `AGENTS.md`; the plugin does **not** create or install a physical global `AGENTS.md`.

The GitHub MCP entry uses OpenCode-managed OAuth by default. OpenCode generally persists OAuth authorization per machine in host-managed storage, but this plugin does not guarantee that this endpoint interoperates with the host OAuth flow or that authentication survives a restart. Those behaviors have not been runtime-verified.

An alternative is to explicitly set `options.mcp.githubAuth` to `"token-file"`. Optionally set `options.mcp.githubTokenFile` to an absolute path; otherwise the token is read from `~/.config/opencode/.secrets/github-key`, or `$XDG_CONFIG_HOME/opencode/.secrets/github-key` when `XDG_CONFIG_HOME` is absolute. Keep the token out of logs and the repository, and restrict access to the file (for example, owner-only permissions such as mode `600` on POSIX systems). This option reads a local token; it does not generate or rotate credentials.

OpenCode V2 plugins cannot install other plugins as nested dependencies. If you want skills managed by another plugin, add that plugin separately to the host's `plugins` list alongside Sherpa—for example, add `"oh-my-opencode-slim@2"` as another array entry. Configure DCP or Playwright plugins separately in the same way when needed; Sherpa does not install them.

The other Caveman skills `caveman-help`, `caveman-compress`, `caveman-stats`, and `cavecrew` are not installed here: their documented workflows depend on features outside this subset, including hooks, scripts, or agents. Non-Caveman local skills from CC Switch are not included; their portable sources have not yet been identified.

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

This Git package selector is an initial configuration example and has not yet been runtime-verified; confirm support with your OpenCode version before relying on it. To remove the plugin, delete its entry from `plugins` and restart OpenCode.

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
│   └── skills.ts
└── test/
    ├── instructions.test.ts
    ├── mcp.test.ts
    ├── permissions.test.ts
    ├── plugin.test.ts
    └── skills.test.ts
```

## Roadmap

MCP registration and the three Caveman skills are available today. Provider or command integrations remain possible future work. Slim, DCP, and Playwright are separate host plugins, not integrations installed by Sherpa.

## License

This project is licensed under the [GNU Affero General Public License v3.0 or later](LICENSE).
