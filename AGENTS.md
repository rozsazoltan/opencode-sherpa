# Agent Guide

## Project

OpenCode Sherpa is a TypeScript ESM plugin for OpenCode V2. It adds session guidance, packaged instructions/skills/commands, directory-permission evaluation, and remote MCP registrations. It does not install external plugins, edit OpenCode host configuration, create custom agents, or manage a global `AGENTS.md`.

## Repository layout

- `src/` — plugin setup and cleanup, instructions, permission handling, MCP registration, and tuning-content discovery.
- `tuning/` — packaged Markdown instructions, skills, and commands discovered at startup.
- `test/` — Bun tests for plugin lifecycle and each runtime feature.
- `README.md` — user-facing installation, configuration, tuning format, and limitations.

## Development

Use Bun to install dependencies and validate changes:

```sh
bun install
bun test
bun run typecheck
```

## Contributor guidance

- Follow the OpenCode V2 plugin API and existing TypeScript patterns. Preserve registration cleanup and existing host entries.
- Keep permission handling conservative: explicit denies stay denied, and directory matching is lexical rather than a filesystem sandbox.
- Keep tuning discovery deterministic and validated. Update tests when changing supported Markdown/frontmatter behavior.
- Do not write to OpenCode host configuration or global `AGENTS.md`, install external plugins, or add custom agents.
- Update `README.md` when user-facing behavior or configuration changes. Keep this guide focused on contributor instructions; avoid duplicating README details.
