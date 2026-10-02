Use Cargo metadata and repository conventions to guide Rust work.
- Check the owning crate, workspace manifest, `Cargo.toml`, `Cargo.lock`, and Rust edition before editing.
- Keep changes within the crate that owns the behavior; preserve workspace dependency and ownership boundaries.
- Use existing Cargo checks at the narrowest useful crate or workspace scope; do not add dependencies or run fix commands without need.
- Report exact checks run and results; mark unavailable or skipped checks clearly.
