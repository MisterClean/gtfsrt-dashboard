# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Rust-first browser application compiled to WebAssembly, with a small JavaScript bridge to the pinned DuckDB-WASM worker. Static assets will be served at `michaelmclean.me/gtfsrt-dashboard/` from the existing website and Railway deployment.

## Users

People exploring a selected transit agency and mode using the public GTFS-RT archive. Specific professional roles remain open.

## Product Purpose

Let a visitor inspect an agency's archived vehicle activity without the website hosting, processing, or receiving their transit working set.

## Capabilities and Constraints

- The user confirmed the bounded archive explorer as the MVP: route activity, hourly coverage, vehicle positions, and inspectable sources.
- Read public archive catalogs and exact Parquet objects directly from the browser, then run bounded DuckDB queries in a worker.
- One feed and UTC day by default; enforce the architecture's object, byte, memory, result, and time budgets.
- Support agency/feed and transit-mode selection only where source metadata supports the distinction. Never invent mode classifications.
- Preserve cancellation, useful missing-data errors, SQL/provenance inspection, and source-quality disclosures.
- No server query API, credentials, transit-data proxy, analytics, or automatic persistent raw-data warehouse.
- Schedule-relative metrics and speed comparisons are outside the confirmed MVP.
- Compile Rust before release; browsers load the compiled modules and run the application locally.
- Keep source public-safe and commit work in logical chunks.

## Brand Commitments

Use the user's CTA Bus Speed Scorecard as the supplied reference: a warm, restrained transit notebook, readable quantitative comparisons, and clear methods. This is a personal transit project, not a Trusted Health or Hex dashboard.

## Evidence on Hand

- `docs/architecture.md`: source contracts, metric boundaries, budgets, and MVP acceptance gates.
- `docs/packaging-security.md`: Rust integration and self-hosted release requirements.
- `docs/evidence/`: real Madison browser-query evidence for November 5, 2026.
- The supplied CTA scorecard and source repository demonstrate the intended family of views; their speed/ridership measures are not available from a simple vehicle archive scan.

## Product Principles

- Execute on the visitor's device and keep resource use bounded.
- Make a small real selection useful before broadening analysis.
- Treat archive coverage as distinct from transit service delivered.
- Carry source selection, metric definitions, and exclusions with every result.
