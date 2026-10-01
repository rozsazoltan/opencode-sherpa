---
name: sherpa-php-development
description: Make focused PHP changes using the repository's installed runtime, Composer configuration, and test tools.
---

# PHP development

1. Read the relevant PHP files, `composer.json`, lockfile, PHP version constraints, and nearby tests before editing.
2. Check configured Composer scripts and installed tools. Use the repository's commands and dependency versions; do not assume a global tool is available.
3. Keep changes compatible with the project's declared PHP version and existing coding style. Prefer narrow types, explicit boundaries, and small functions.
4. Follow existing Composer autoloading and namespace conventions. Do not add dependencies when existing capabilities solve the task.
5. Add or update focused tests for behavior changes. Use Pest only when project dependencies and tests show Pest is configured.
6. Run relevant configured tests and checks. Use Rector only when the project already configures it and the task needs a structural transformation.
7. Report files changed, checks run, and any remaining uncertainty. Do not claim checks that were not run.
