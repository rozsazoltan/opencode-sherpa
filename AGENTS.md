# Agent Guide

## Project

OpenCode Sherpa is a TypeScript ESM plugin for OpenCode V2. It adds session guidance, packaged instructions/skills/commands, OMO-Slim custom agents, directory-permission evaluation, and remote MCP registrations. Agent sync is project-local: it updates `.opencode/oh-my-opencode-slim.jsonc` (or existing sole `.json`) and `.opencode/oh-my-opencode-slim/`. It never modifies global OMO-Slim config/prompts, the main OpenCode config, global `AGENTS.md`, or unrelated files; it does not install external plugins.

## Repository layout

- `src/` — plugin setup and cleanup, instructions, permission handling, MCP registration, tuning discovery, and OMO-Slim agent sync.
- `tuning/` — packaged Markdown instructions, skills, and commands; external agent sources are resolved and cached separately.
- `test/` — Bun tests for plugin lifecycle and runtime/config-sync features.
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
- Resolve pinned agent sources into a safe shared cache. Restrict sync to project-local OMO-Slim config and prompt files. At startup, treat every root/preset key starting `sherpa` and every top-level `sherpa*.md` agent prompt as Sherpa-managed; reconciliation may delete or replace user edits in that namespace. Preserve all other entries/files and never traverse linked paths.
- Adapt third-party prompts to OpenCode/OMO-Slim and retain required license notices.
- Update `README.md` when user-facing behavior or configuration changes. Keep this guide focused on contributor instructions; avoid duplicating README details.
