# Agent Guide

## Project

OpenCode Sherpa is a TypeScript ESM plugin for OpenCode V2. It adds session guidance, packaged instructions/skills/commands, OMO-Slim custom agents, directory-permission evaluation, and remote MCP registrations. Agent sync may update OMO-Slim's user-level config and Sherpa-owned prompt files. It must preserve user edits and never modify the main OpenCode config, global `AGENTS.md`, or unrelated files; it does not install external plugins.

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
- Resolve pinned agent sources into a safe cache. Restrict sync to OMO-Slim config and Sherpa-owned prompt files; preserve user edits and unrelated global settings.
- Adapt third-party prompts to OpenCode/OMO-Slim and retain required license notices.
- Update `README.md` when user-facing behavior or configuration changes. Keep this guide focused on contributor instructions; avoid duplicating README details.
