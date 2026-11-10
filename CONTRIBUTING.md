# Contributing

Thanks for helping. This file covers setting up, the checks to run before a pull request, and the rules that are easy to miss. If something here doesn't work, that's a bug in this file, so please open an issue.

## Setup

You need three things.

1. **Node.js 24.** CI uses 24 and `package.json` requires `>=24`. `.nvmrc` pins it, so `nvm use` works.
2. **Rust through rustup.** `rust-toolchain.toml` pins Rust 1.99.1 with the `wasm32-unknown-unknown` target, and only rustup reads that file. A Homebrew or distro Rust has no WASM target, and the build fails with `can't find crate for core`. Install from <https://rustup.rs>, remove other Rust installs from your `PATH` (for example `brew uninstall rust`), and open a new shell. Inside the repo, rustup installs the pinned toolchain and target the first time you run `cargo`. To add the target by hand: `rustup target add wasm32-unknown-unknown`.
3. **wasm-bindgen 0.2.105, exactly.** The CLI must match the `wasm-bindgen` crate in `Cargo.lock`:

   ```sh
   cargo install wasm-bindgen-cli --version 0.2.105 --locked
   ```

Then:

```sh
npm ci --ignore-scripts
npm run build:wasm    # compile the Rust engine
npm run dev           # Vite dev server
```

`scripts/build.mjs` checks the Rust setup before compiling. If rustup, the WASM target or the wasm-bindgen version is wrong, it prints the command that fixes it. `CARGO` and `WASM_BINDGEN` override tool paths.

The first release build downloads the DuckDB extensions once and checks them against pinned hashes, so it needs network access.

## Before you open a pull request

CI runs all of these. Run the ones that match what you changed.

```sh
cargo fmt --all --check
cargo clippy --locked -p transit-core --all-targets -- -D warnings
cargo clippy --locked -p transit-wasm --target wasm32-unknown-unknown -- -D warnings
cargo test --locked -p transit-core
npm test                  # URL rules, dates, CSV safety, security policy
npm run build:wasm
npm run check             # TypeScript and Svelte; needs build:wasm first
npm run build
npm run verify:release
```

`npm run check` reports errors until `npm run build:wasm` has produced `.build/pkg`.

Two more checks aren't in CI:

```sh
cargo test -p transit-core --test sql_contract -- --ignored   # needs the duckdb CLI
npm run test:e2e                                              # built release against the live archive
npm run test:e2e:states                                       # startup, stop, failure and day states, same archive
```

The end-to-end tests need Chrome. Set `CHROME_PATH` to an installed browser if Playwright's own Chromium isn't available. They read the live archive, so a failure can be the archive and not your change. The second one cuts its own connection to the archive partway through, through a local proxy, to check what the page says when a run fails.

## Rules that are easy to miss

- **Changing a calculation means bumping `METRIC_VERSION`** in `crates/core/src/cube.rs`. Browsers cache finished days keyed by that number, so without a bump people keep seeing old results. Bump it for any change to what a stored number means, including thresholds, filters and new fields in the daily rollup. Don't bump it when results stay the same. Update `docs/metrics.md` in the same pull request.
- **Nothing leaves the browser.** The security policy lists the only hosts the app may contact. A new host needs a reason in the PR. See `docs/packaging-security.md`.
- **SQL comes from fixed templates.** Don't build queries from user input.
- **Missing isn't cancelled.** Wording and metrics shouldn't claim a trip was cancelled because the feed has no data for it. `docs/metrics.md` explains.
- **Old names stay.** The IndexedDB database and localStorage keys still say `transit-notebook`, and the repo is `gtfsrt-dashboard`. The keys are kept on purpose so existing users keep their cached days and settings. Don't rename them without a migration.
- **Don't hand-edit build output.** `dist/`, `.build/`, `target/`, `.cache/` and `public/engine/` are ignored.

## Where things are

- `docs/architecture.md`: the pipeline and why it's built this way
- `docs/metrics.md`: every definition and threshold
- `docs/validation.md`: what was checked and what wasn't
- `docs/packaging-security.md` and `docs/hosting.md`: release contents, security model, deploying
- `DESIGN.md` and `PRODUCT.md`: design system and product brief
- `spike/` and `docs/evidence/`: the original feasibility work, kept for reference

The README has the project layout.

## Pull requests

Keep them focused and say what you ran. The PR template lists what reviewers look for. Changes to numbers need a note on how you checked them. By contributing you agree your work is released under the [MIT license](LICENSE).

Please follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report security problems as described in [SECURITY.md](SECURITY.md), not in a public issue.
