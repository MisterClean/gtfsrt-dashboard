## What changed and why

## How I checked it

- [ ] `npm test` and `npm run check`
- [ ] `cargo fmt`, `cargo clippy` and `cargo test -p transit-core` (if Rust changed)
- [ ] `npm run build` and `npm run verify:release` (if the build, security policy or packaging changed)

## If a number changed

- [ ] `METRIC_VERSION` in `crates/core/src/cube.rs` is bumped
- [ ] `docs/metrics.md` matches the code
- [ ] I compared results on a real feed and day, noted here:

## Privacy and security

- [ ] No new host is contacted, or the reason is explained above
- [ ] No transit data leaves the browser
