# Transit Notebook

A Rust-first, browser-local GTFS-RT archive explorer. Select an agency/feed and up to six UTC days, then inspect vehicle activity, routes, hourly coverage, and vehicle positions. DuckDB runs in a browser worker; the website serves static application assets. Transit files are requested directly from gtfsrt.io’s public Google Storage bucket.

The MVP includes agency/date selection, historical GTFS route-type mode filters, hourly charts, a searchable and sortable route table, a route heatmap, a geographic coordinate plot, inspectable SQL, CSV export, downloadable provenance, and selection links. Raw observations include repeated polls; they do not measure completed journeys, scheduled service, ridership, speed, or on-time performance. UTC dates differ from local and GTFS service days.

## Build and preview

Development requires Node.js 22+ and a rustup-managed Rust installation. Visitors need only a browser. The pinned toolchain in `rust-toolchain.toml` includes the WASM target; a Homebrew-only Rust installation needs that target added separately.

```sh
npm ci --ignore-scripts
cargo install wasm-bindgen-cli --version 0.2.105 --locked
npm run build
npm run dev
```

Open [the local dashboard](http://127.0.0.1:4173/gtfsrt-dashboard/). Use `PORT=4174 npm run dev` if the feasibility probe occupies port 4173. Rebuild and reload after source changes; the server serves the completed `dist/` release. `CARGO` and `WASM_BINDGEN` can override build-tool paths.

The build downloads official signed Parquet and ICU extensions into ignored `.cache/` files and verifies pinned SHA-256 hashes. The release self-hosts all application JS/WASM, DuckDB JS/WASM and extensions, CSS, font, and icon. Visitors need no runtime CDN, Rust compiler, credentials, account, data upload, or query server.

```sh
npm run verify:release
npm run package
```

`dist/` is the deployable static directory. The package command verifies and archives it under `.build/`. It contains no transit working data. Relative asset URLs work beneath `/gtfsrt-dashboard/`.

## Validate

```sh
cargo fmt --all --check
cargo clippy --locked --all-targets -- -D warnings
cargo clippy --locked --target wasm32-unknown-unknown -- -D warnings
cargo test --locked
npm test
npm run build
npm run verify:release
```

An independent analytical-contract test executes the generated SQL in an installed native DuckDB CLI, without a live archive connection:

```sh
cargo test --locked --test analytical_contract -- --ignored
```

Set `DUCKDB_BIN` when the CLI is not on `PATH`. These tests cover repeated fixes, null IDs, mode separation, injected filter values, latest-invalid-position exclusion, timestamp fallback, and differential-feed gating.

The MVP was exercised in the visible Chromium browser with Madison bus and SEPTA regional rail archives for November 5, 2026. Madison’s 296,588 observations, 151 vehicle IDs, 29 route IDs, and 1,664 trip IDs matched an independent native calculation. See [validation evidence and remaining browser limits](docs/mvp-validation.md). Safari, Firefox, Edge, constrained devices, and actual peak tab memory still require testing before claiming support.

## Hosting and architecture

- [Integration into michaelmclean.me and Railway](docs/hosting.md)
- [Architecture and analytical boundaries](docs/architecture.md)
- [Rust packaging and browser security](docs/packaging-security.md)
- [Original feasibility experiment](docs/feasibility.md)
- [Product scope](PRODUCT.md)

Rust handles planning, validation, mode classification, SQL templates, the Leptos interface, rendering, and export content. `web/bridge.js` handles browser I/O, DuckDB lifecycle, and bounded Arrow-result conversion. `scripts/` builds and serves static files; it does not process transit data.

The preview enforces CSP on both page and worker responses. Production needs the same headers; copying files alone does not install a policy. The only allowed external connection destination is the public `parquet.gtfsrt.io` Google Storage bucket. The temporary database clears on reload/cancel, but ordinary browser HTTP caches may retain responses. Direct archive requests disclose requested objects and the visitor’s network address to the archive host.

The tested npm wrapper is `@duckdb/duckdb-wasm@1.33.1-dev114.0`, a pinned prerelease. The SQL engine reports `v2.0.0`; the wrapper and engine use separate version numbers.

## Original experiment

```sh
npm run probe:serve
npm run probe
```

The retained probe serves `/spike/index.html` and records feasibility evidence. Its executable-dependency policy is less strict than the packaged application. It is a research tool, not the deployable dashboard.
