---
name: sherpa-js-development
description: Make focused JavaScript or TypeScript changes that fit the repository's Node.js and package tooling.
---

# JavaScript and TypeScript development

1. Read the affected source, package manifest, lockfiles, runtime constraints, and nearby tests before editing.
2. Reuse the package manager identified by the lockfile. Do not replace or regenerate another manager's lockfile.
3. Match the declared Node.js version, module system, TypeScript settings, and existing code style. Preserve public API behavior unless the task asks to change it.
4. Use existing package scripts for tests, linting, and builds. Check package configuration before assuming Vite, Vitest, or another tool is installed.
5. Prefer explicit types and small functions. Add tests for changed behavior and cover relevant error paths.
6. Use OXC or other fast tooling only when it is already installed and configured. Do not add a tool solely to run one check.
7. Run the narrowest relevant checks, then report exact commands and results. State clearly when a check was unavailable or skipped.
