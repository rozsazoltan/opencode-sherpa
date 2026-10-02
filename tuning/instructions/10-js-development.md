Use the owning package's manifest, workspace configuration, lockfile, and runtime constraints to guide JavaScript or TypeScript work.
- Keep changes within the package that owns the behavior; preserve its module system, language settings, and established conventions.
- Use only scripts and test tools already configured for the project; do not assume a framework or package manager.
- Prefer focused changes and tests. Do not add dependencies or regenerate lockfiles unless the task requires it.
- Report exact checks run and results; mark unavailable or skipped checks clearly.
