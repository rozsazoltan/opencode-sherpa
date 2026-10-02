---
description: Inspect a Rust workspace and run configured checks for the task.
---
Task: $ARGUMENTS

Identify the owning crate from `Cargo.toml` and workspace declarations. Inspect its manifest, workspace settings, `Cargo.lock`, edition, and relevant files. Use the existing `sherpa-rust-development` skill when available. If unavailable or unselected, follow the same safeguards: preserve crate ownership and workspace conventions, and use only installed tools and existing Cargo checks. Run only relevant checks at the narrowest useful crate or workspace scope. Do not invent commands or add dependencies. Report exact commands and results, and list skipped or unavailable checks.
