---
description: Inspect a PHP project and run configured checks for the task.
---
Task: $ARGUMENTS

Identify the owning Composer package. Inspect its `composer.json`, lockfile, autoload rules, PHP version constraint, relevant files, and configured scripts. Use the existing `sherpa-php-development` skill when available. If unavailable or unselected, follow the same safeguards: use only installed PHP, Composer, and project-configured test or analysis tools; preserve package boundaries and autoload conventions. Run only existing, relevant checks for the owning package. Do not invent commands or install dependencies. Report exact commands and results, and list skipped or unavailable checks.
