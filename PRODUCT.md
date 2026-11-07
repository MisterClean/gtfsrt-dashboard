# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

A static web application. TypeScript and Svelte 5 for the interface, built with Vite. Rust compiled to WebAssembly for all analytics, running in a worker beside the pinned DuckDB-WASM engine. MapLibre GL for maps. Static assets will be served at `michaelmclean.me/gtfsrt-dashboard/` from the existing website and Railway deployment.

## Users

Transit planners, service analysts and agency staff who today spend weeks building this kind of reporting by hand, and the advocates and journalists who hold agencies to account. They know what operating speed, timepoints and headway adherence mean, and they will check a number before they repeat it. They usually work at a desktop during the day.

## Product Purpose

Put the reporting a seasoned planner would build for themselves at their fingertips, from public data, for any agency in the GTFS-RT archive. The goal is decisions: bus lanes, signal priority, stop consolidation and schedule changes. The dashboard shows where and when service loses time, and how sure we are.

## Capabilities and Constraints

- Read public archive catalogs and Parquet objects directly from the browser. Run all queries and analysis on the visitor's device.
- The website must never receive, proxy or process transit data. No server query API, credentials, accounts, analytics or data upload.
- Show the expected download before anything starts, and stop on request while keeping finished days.
- Keep derived results in the visitor's browser, visible and clearable. Never persist raw vehicle data.
- Never invent a classification or claim beyond the evidence. An absent trip is not proof of a cancellation, and there is no ridership in the archive.
- Carry definitions, exclusions and thresholds with every result. Everything must be exportable.
- Keep source public-safe and commit work in logical chunks.

## Brand Commitments

Use the CTA Bus Speed Scorecard as the reference for a warm, restrained visual style, readable comparisons, and clear methods. This is a personal transit project, not a Trusted Health or Hex dashboard.

## Evidence on Hand

- `docs/metrics.md`: every metric's definition, formula and limits.
- `docs/architecture.md`: the pipeline, source contracts and resource bounds.
- `docs/validation.md`: independent checks against raw data, and results for every agency in the archive.
- `docs/packaging-security.md`: release contents and the security model.
- The CTA scorecard and its source: https://github.com/MisterClean/cta-bus-speed-scorecard

## Product Principles

- The visitor's device does the work, and the host stays out of the data path.
- Show something real quickly and refine it: results appear after the first day and improve with each one added.
- Lead with the finding, then let the planner drill down to the evidence.
- Measure the same way in every period, so comparisons mean what they appear to mean.
- Say what isn't known as plainly as what is.
