# @rozsazoltan/opencode-sherpa-plugin

Optional global OpenCode plugin for bootstrapping and upgrading the project-local Sherpa CLI. Sherpa's primary product remains the project-specific CLI package, `@rozsazoltan/opencode-sherpa`.

Install with OpenCode V2:

```sh
opencode plugin add @rozsazoltan/opencode-sherpa-plugin@latest
```

The plugin asks for project-scoped consent before setup. It never runs shell commands itself; `/sherpa-install` and `/sherpa-upgrade` ask the model to use ordinary permissioned OpenCode tools. Review package and lockfile changes and dependency lifecycle scripts before approving commands.

This package is licensed under AGPL-3.0-or-later. It targets the documented OpenCode Plugin API V2; runtime compatibility is not verified against every OpenCode release.
