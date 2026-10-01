# Agent Guide

## Project

OpenCode Sherpa is a TypeScript ESM CLI for explicitly syncing reusable OpenCode project files. It is not an OpenCode plugin and does not provide runtime hooks.

## Repository layout

- `src/` — CLI argument handling, project sync, tuning discovery, MCP config merge, and cached OMO-Slim agent sources.
- `dist/` — committed Node-compatible CLI output used by pnpm Git installs.
- `tuning/` — packaged Markdown instructions, skills, and commands.
- `test/` — Bun tests for CLI behavior and sync modules.
- `README.md` — user installation, configuration, sync behavior, and limitations.

## Development

Use Bun to install dependencies and validate changes:

```sh
bun install --frozen-lockfile
bun test
bun run typecheck
bun run build
```

## Contributor guidance

- Keep all filesystem changes project-scoped. Never write global OpenCode config or run sync against the user's real project during tests.
- Preserve unrelated JSONC settings, MCP entries, user-owned files, and edits. Keep generated-file ownership checks and dry-run non-mutating.
- Resolve pinned agent sources into the safe shared cache; reject unsafe archives, paths, and symlinks.
- Keep tuning discovery deterministic and validated. Update tests when changing supported Markdown/frontmatter behavior.
- The old runtime permission hook is intentionally removed; do not add plugin lifecycle or permission interception back to the CLI.
- Update `README.md` when user-facing behavior or configuration changes. Keep this guide focused on contributor instructions; avoid duplicating README details.
