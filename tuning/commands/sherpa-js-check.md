---
description: Inspect a JavaScript or TypeScript project and run configured checks for the task.
---
Task: $ARGUMENTS

Identify the owning package from manifests and workspace declarations. Inspect relevant files, package scripts, lockfile, and runtime constraints; avoid generated and dependency trees. Use the existing `sherpa-js-development` skill when available. If unavailable or unselected, follow the same safeguards: respect the configured runtime, module system, package manager, and test tools; make no framework assumptions. Run only existing, relevant checks for the owning package. Do not invent commands, install dependencies, or change lockfiles. Report exact commands and results, and list skipped or unavailable checks.
