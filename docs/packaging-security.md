# Packaging and browser security

One versioned static release contains every executable dependency. A visitor opens an HTTPS URL and installs nothing. The public archive remains an external data source, and the optional basemap is the only other outside connection.

| Part | Release artifact |
| --- | --- |
| Rust analytics and SQL templates | `transit_wasm_bg-[hash].wasm`, with generated bindings |
| Interface | `index-[hash].js` and `index-[hash].css` from Vite and Svelte |
| Engine worker | `worker-[hash].js` |
| SQL engine | `duckdb-base-[hash].wasm` and `duckdb-browser-base.worker-[hash].js`, pinned |
| DuckDB extensions | Signed Parquet and ICU files at `engine/extensions/v2.0.0/wasm_eh/`, SHA-256 pinned |
| Map renderer | Bundled MapLibre, with `maplibre-gl-worker-[hash].mjs` |
| Font and icons | Self-hosted font, inline SVG icons |
| Build tools | Used during development and CI, never by visitors |

The earlier design used a Rust interface through Leptos. [Architecture](architecture.md) explains why the interface moved to TypeScript while the analytics stayed in Rust.

The browser's WASM sandbox limits what any of this can reach, but it doesn't make code automatically trustworthy. Memory corruption inside a C++ module, abuse of permitted APIs and resource exhaustion all remain possible, so the rules below still apply. Rust reduces memory-safety errors in safe Rust code. It does not change DuckDB's implementation or replace browser policies.

## Security model

Protect the user's browser, local data, privacy and device resources from malicious source content, unexpected network requests, compromised dependencies and excessively large queries. A worker keeps computation off the UI thread; it is not a separate security origin. See the [WebAssembly security model](https://webassembly.org/docs/security/).

Production requirements:

1. **Control executable dependencies.** Self-host pinned Rust, JavaScript, DuckDB and any necessary signed extension files. Review lockfile changes, scan dependencies, retain build provenance and apply security updates deliberately. Disable unnecessary extension installation/loading and unsigned/community extensions using settings verified against the chosen build. The currently tested wrapper is a prerelease and needs an explicit release-quality gate.
2. **Restrict browser capabilities and networking.** Request no filesystem, location, camera or other device permissions for archive exploration. Keep secrets and credentials out of all client assets. Serve an enforced Content Security Policy on both the page and worker responses, restricting scripts/workers to our release and connections to required application/archive endpoints. Permit WASM compilation without broadly enabling JavaScript evaluation. The exact policy must be tested, not copied into production on assumption.
3. **Constrain inputs before SQL.** Expose fixed analytical operations with prepared values. Validate dates, feed types, identifiers and result limits. Construct and validate HTTPS URLs by parsed origin and exact archive bucket/path prefix; allowing all of `storage.googleapis.com` would include unrelated buckets. Do not accept arbitrary SQL or fetch URLs from archive text, query strings or shared dashboard configurations.
4. **Treat archive text as data.** Escape names and alerts; never insert producer content as HTML or code. Validate link schemes and destinations. Do not automatically load images or other resources mentioned in archive content.
5. **Bound work and recover.** Cap selected objects, bytes, result sizes and concurrency. Apply a DuckDB memory target, query deadlines and a main-thread-controlled worker termination/reset path. Compressed file size and the database memory setting do not bound total browser memory. Validate behavior on constrained devices.
6. **Keep privacy claims precise.** Run SQL locally and avoid analytics and unnecessary third-party resources. Direct archive requests still disclose the requested objects and network address to the archive's hosting provider. A future map provider adds a separate network recipient. Use a restrictive referrer policy and make optional persistent caches visible and clearable.

[DuckDB's security guidance](https://duckdb.org/docs/2.0/operations_manual/securing_duckdb/overview) treats untrusted SQL and resource consumption as security concerns. WASM hosting narrows the available capabilities, but the application must still control what it asks DuckDB to do.

**Worker policy matters:** a same-origin worker generally does not inherit the document's CSP. `worker-src` limits worker creation; a CSP on the worker response constrains the worker's subsequent behavior. See [worker CSP](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers#content_security_policy) and [WASM compilation policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/script-src#unsafe_webassembly_execution).

## How the release meets these

| Requirement | Implementation | Checked by |
| --- | --- | --- |
| Self-hosted, pinned dependencies | `package-lock.json`, `Cargo.lock`, pinned extension hashes | `npm run verify:release` |
| Enforced policy on page and workers | `scripts/security.mjs` served by `scripts/serve.mjs` | Browser run with no policy violations, and `tests/contracts.test.mjs` |
| No JavaScript evaluation | `'wasm-unsafe-eval'` only, no `'unsafe-eval'` or inline scripts | `tests/contracts.test.mjs` |
| No inline styles in production | `style-src 'self'`, with Svelte's `style:` directive using the CSSOM | Browser run with no policy violations |
| Fixed SQL | Templates in `crates/core/src/sql.rs` with checked aliases and typed casts | Unit tests and `crates/core/tests/sql_contract.rs` |
| Archive URLs only | `validateArchiveURL` checks origin and exact bucket prefix | `tests/contracts.test.mjs` |
| Source text is data | Svelte escapes text by default, and the app never uses `{@html}` | Code review |
| CSV safety | `csvCell` defuses values a spreadsheet would run as formulas | `tests/contracts.test.mjs` |
| Bounded work | [Resource bounds](architecture.md#resource-bounds) and a stop control | Code review, browser run |

## Who sees what

- **The website host** serves static files and sees ordinary page requests. It receives no transit data and no analysis results.
- **The archive host (Google Cloud Storage)** sees the visitor's network address and which objects they request, because the browser fetches them directly.
- **OpenFreeMap** sees the visitor's network address and the map area on screen when the street basemap is on. It needs no key or account, and the visitor can turn it off. Transit data never goes there.

The app runs no analytics. Results stay in the visitor's browser until they clear them.

The basemap is the one outside dependency added since the MVP, and it is a deliberate trade-off. Planners need street names to locate a problem. If the tiles fail to load or the visitor turns them off, the speed lines still draw on a plain background.

## Open gates

The app has run in Chromium only. Before claiming wider support, test Safari, Firefox and Edge, a constrained-memory device, an HTTPS deployment with real headers, and asset upgrades across releases. Passing these checks establishes a baseline. It is not a claim that the application is free of vulnerabilities.
