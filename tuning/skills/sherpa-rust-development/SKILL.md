---
name: sherpa-rust-development
description: Make focused Rust changes that respect crate and workspace ownership, error conventions, and existing tests.
---

# Rust development

1. Inspect the relevant crate's `Cargo.toml`, workspace manifest, `Cargo.lock`, source, and nearby tests.
2. Confirm which crate owns the behavior. Avoid unrelated workspace-wide edits and dependency changes.
3. Follow the repository's Rust edition, naming, visibility, error-handling, and async conventions.
4. Prefer clear ownership and borrowing. Use existing error types and propagation patterns instead of adding parallel abstractions.
5. Add focused unit or integration tests for changed behavior, including meaningful failure cases.
6. Run formatting, tests, and lint checks at the narrowest useful crate or workspace scope. Use only tools available in the repository environment.
7. Report commands run, results, and skipped checks without implying broader validation than performed.
