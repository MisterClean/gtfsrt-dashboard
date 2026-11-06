# MVP validation — November 6, 2026

The bounded explorer is implemented in Rust/Leptos with a small JavaScript bridge to a DuckDB-WASM worker. The completed `dist/` directory is a static release, not a transit data warehouse. Production deployment has not been performed.

## Real browser selections

Tested through the visible in-app Chromium browser at `http://127.0.0.1:4174/gtfsrt-dashboard/`, with ordinary browser security and enforced CSP on page and worker responses.

| Selection | Observations | Distinct reported vehicle IDs | Distinct nonempty route IDs | UTC hours with records |
| --- | ---: | ---: | ---: | ---: |
| Madison vehicle positions, 2026-11-05 | 296,588 | 151 | 29 | 23 / 24 |
| SEPTA Regional Rail vehicle positions, 2026-11-05 | 180,258 | 248 | 13 | 23 / 24 |

Madison additionally has 1,664 distinct nonempty trip IDs and 40,990 rows without a route ID. Those missing-route rows remain visible as an unreported-route group, separate from the 29 identified routes. Bus route A has 34,408 observations, 31 vehicle IDs, and 134 trip IDs. Mode filtering comes from applicable historical `routes.parquet` metadata; SEPTA’s selection offered Rail and Madison offered Bus plus unmatched routes.

An independent native DuckDB CLI calculation over the downloaded public Madison object reproduced all four headline ID/observation totals. The CLI was `v2.0.0-dev88614`, source `d54cbbe3df`; the browser SQL engine reports `v2.0.0`. This is result parity, not a claim of independent event-reconstruction validation.

The Madison object was 34,180,170 bytes (32.6 MiB). The first packaged calculation completed in approximately 4.6 seconds; a subsequent final-build load was 4.7 seconds. Route/mode filter recomputations were approximately 0.2–0.6 seconds and used the normalized temporary table. These are observed SQL-stage timings on this machine, excluding catalog, engine startup, and historical route discovery; they are not general performance guarantees. HTTP caching was not globally purged between runs.

## Exercised behavior

- Agency/feed changes, historical mode selection, date controls, local route filtering, clear filters, and shared selection URLs.
- Overview vehicles/observations chart, exact hourly table, route activity bars, coverage grid, field missingness, sortable/searchable route table, heatmap, positions, and source/SQL views.
- A real route CSV download and provenance JSON download were opened and inspected. Provenance contained source objects and bytes, selected schedule digest, schema columns, filters, seven SQL statements, and result tables. Copy selection link produced its success state.
- An oversized five-day Madison selection was rejected at **158.4 MiB before DuckDB startup**. Immediate cancellation cleared the worker/database; a subsequent selection loaded successfully.
- Native fixture tests verify repeated fixes remain in raw totals; absent IDs remain distinct from zero; mode filtering separates unmatched IDs; filter text cannot alter SQL; an invalid latest report does not resurrect an older coordinate; missing vehicle time has a disclosed fetch-time fallback; differential observations disable position reconstruction.
- Unit/contract tests cover invalid and cross-month dates, the six-object and aggregate byte bounds, canonical URL restrictions, optional-column normalization, historical schedule selection, CSV formula neutralization, and the page/worker policy contract.

## Build and visual checks

Eight Rust unit tests, two independent native SQL tests, and four Node contract tests passed. Rustfmt, native and WASM Clippy with warnings denied, the release WASM build, and static release integrity verification passed. The CI workflow applies the portable checks and release build; native CLI fixture tests remain an explicitly invoked local check.

Browser layouts were captured at 1440px desktop, 390px mobile, and the actual 772px in-app viewport. The first review identified SVG label shrinkage, a long schedule digest overflowing Sources, and inconsistent arrow icons; these were repaired with readable intrinsic chart widths, contained scrolling and visible hints, digest wrapping, and authored SVG icons. The finish reviewer returned **ship** after inspecting the corrected captures: all three material fixes resolved, with no material regressions observed. At the390px viewport, Overview, Routes, and Positions each had document width equal to scroll width390px; every chart rendered at1120px intrinsic width with11px axes. Sources had equal document/scroll width379px after excluding the visible scrollbar. The explicit772px capture similarly had761px content width.

The mechanical design detector returned no findings. It warned that the source HTML template’s `__STYLE__` placeholder could not be resolved; the CSS file was also supplied directly. A separate finish reviewer inspected the rendered views.

## Runtime packaging and limits

All executable application dependencies are self-hosted: Rust WASM and generated JS, DuckDB engine and matching worker, and SHA-256-pinned signed Parquet/ICU extensions. Automatic extension installation/loading and community/unsigned extensions are disabled. The explicit extension mirror is on the application origin. The page and worker share an enforced CSP allowing external connections only to the exact public archive bucket path. No analytics, persistent database, external basemap, data proxy, or server query endpoint is present.

The raw plan is capped at six daily objects and 128 MiB of summed compressed object sizes; auxiliary metadata files have separate 2 MiB checks. Results are bounded to 500 route groups, 12,000 route/hour rows, 144 hourly coverage rows, and 5,000 latest vehicle positions, below 20,000 total transferred rows. The configured DuckDB memory target is 512 MB; total tab memory can be higher. Queries request cancellation at 15 seconds and force a reset at 30 seconds. Compressed bytes do not predict total network transfer or memory use.

## Remaining gates

- Safari, Firefox, Edge, constrained-memory devices, actual peak tab/worker memory, and a release-quality assessment of the pinned prerelease wrapper.
- Production HTTPS policy and all asset/network destinations after integration into the website’s nginx/Railway deployment.
- Live 404/transient-failure and deliberately stalled-query browser fixtures; current missing-object/schema behavior is covered by planning/contracts and independent fixtures, not by a forced live outage test.
- Historical schedule trip/stop matching, arrival reconstruction, service-day/DST analysis, speed estimates, and cross-agency benchmarking. These are outside the user-confirmed archive-explorer MVP.

The position plot is a coordinate view without a basemap. It shows each vehicle’s latest archived report, not simultaneous or live positions. Missing archive data never establishes missed service or cancellation.
