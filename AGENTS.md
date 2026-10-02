# Agent Guide

## Project

OpenCode Sherpa is a TypeScript ESM CLI for explicitly syncing reusable OpenCode project files. It is not an OpenCode plugin and does not provide runtime hooks.

## Repository layout

- `src/` — CLI argument handling, bounded project detection, content selection/catalog, project sync, tuning discovery, MCP config merge, and verified pinned agent/skill source caching.
- `src/cli.ts` — TypeScript CLI implementation and direct-source entrypoint.
- `bin/sherpa.js` — installed CLI launcher for the packaged TypeScript source.
- `tuning/` — packaged Markdown instructions, skills, and commands.
- `test/` — Bun tests for CLI behavior and sync modules.
- `README.md` — user installation, configuration, sync behavior, and limitations.

## Development

Use Bun to install dependencies and validate changes:

```sh
bun install --frozen-lockfile
bun test
bun run typecheck
```

## Contributor guidance

- Keep all filesystem changes project-scoped. Never write global OpenCode config or run sync against the user's real project during tests.
- Preserve unrelated JSONC settings, MCP entries, user-owned files, and edits. Keep generated-file ownership checks and dry-run non-mutating.
- Resolve pinned agent and skill sources through the shared verified cache. Never extract or follow symlinks; reject unsafe entries and links affecting selected skill paths or licenses. Agent sources remain strict. Keep upstream skill paths, support files, license evidence, and provenance limited to selected entries.
- Keep tuning discovery deterministic and validated. Update tests when changing supported Markdown/frontmatter behavior.
- Bound project detection to manifests, workspace declarations, and explicit/shallow project paths. Preserve exclusions and never scan dependency/generated trees or follow symlinks. Keep automatic content rules curated; keep uncataloged optional content off unless explicitly selected.
- The old runtime permission hook is intentionally removed; do not add plugin lifecycle or permission interception back to the CLI.
- Update `README.md` when user-facing behavior or configuration changes. Keep this guide focused on contributor instructions; avoid duplicating README details.
