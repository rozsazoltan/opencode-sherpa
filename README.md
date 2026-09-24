# opencode-sherpa

`opencode-sherpa` is an initial TypeScript ESM baseline for an OpenCode V2 plugin. Its OpenCode plugin API dependency is pinned to `@opencode/plugin` `2.0.16`.

## What it does today

- Adds session context instructions that use the configured conversation language, while keeping engineering artifacts such as code identifiers, comments, commits, issues, and pull requests in English. Set `options.language` to a language such as `hu`; without a valid value, the plugin does not force a conversation language.
- Handles OpenCode V2's separate `external_directory`, `read`, and `edit` actions. A matching `ask` may be allowed for paths under the default allowed root, `path.join(os.tmpdir(), "opencode")`, or an added `allowDirectories` root. `denyDirectories` takes priority over allowed roots: a matching request is denied even if its previous effect was `allow` when this hook runs. An explicit configured deny is never overridden.

The context instructions are runtime instructions, similar in purpose to `AGENTS.md`; the plugin does **not** create or install a physical global `AGENTS.md`. It does not install other plugins or manage credentials. Keep credentials out of the repository.

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
│   └── permissions.ts
└── test/
    ├── instructions.test.ts
    ├── permissions.test.ts
    └── plugin.test.ts
```

## Roadmap

Future integration lanes may include MCP, providers, skills and commands, Slim/DCP, and Playwright. These are roadmap ideas, not features delivered by this initial baseline.

## License

This project is licensed under the [GNU Affero General Public License v3.0 or later](LICENSE).
