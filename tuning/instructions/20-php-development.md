Use Composer metadata and installed PHP tooling to guide PHP work.
- Check the owning Composer package, `composer.json`, lockfile, autoload rules, and declared PHP version before editing.
- Follow existing namespaces and autoload conventions; keep changes within the package that owns the behavior.
- Use only configured Composer scripts and installed test or analysis tools; do not add dependencies without need.
- Report exact checks run and results; mark unavailable or skipped checks clearly.
