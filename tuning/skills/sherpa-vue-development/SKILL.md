---
name: sherpa-vue-development
description: Make focused Vue changes consistent with the installed Vue version, component conventions, and configured build tools.
---

# Vue development

1. Read the package manifest, lockfile, Vue version, component, nearby composables, and existing component tests.
2. Follow the repository's Composition API or Options API pattern. Do not migrate neighboring code without a task requirement.
3. Keep component state and emitted events explicit. Preserve prop and event contracts unless the task changes them.
4. Check installed routing, state, and UI libraries before using their APIs. Do not assume a plugin or build tool exists.
5. Add focused tests with the test framework already configured. Cover user-visible behavior and relevant empty or error states.
6. Use existing scripts for type checking, tests, and builds. Keep changes compatible with the declared runtime and Vue versions.
7. Report checks and any behavior not covered by tests.
