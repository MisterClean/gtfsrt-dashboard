# CTA route scorecard snapshot

The CTA snapshot is a fixed, precomputed version of the Routes scorecard and route detail reports. It uses the same Svelte views and native analytics core as Transit Almanac. Opening a snapshot fetches only its derived JSON reports; it does not start DuckDB or the live archive worker.

The one-time sample is the 20 completed Chicago weekdays from October 13 through November 9, 2026. A completed date does not imply complete archive coverage. Known collection gaps remain in the sample and are reported in Data & methods. The sample is fixed; the published Site does not refresh itself.

## Build and stage

Generate the snapshot with the [CTA preparation/export workflow](cta-source.md), keeping the download and intermediate files under `.cache/cta/`. The exporter writes `.cache/cta/snapshot/index.json`, a detail report per route, and compressed companions for trip diagrams:

```sh
node scripts/cta-source.mjs
cargo run --release -p transit-core --example export_cta_snapshot -- .cache/cta .cache/cta/snapshot
npm run build
npm run package:cta-site
```

The staging command writes `.cache/cta/site/dist/` and preserves an existing `.cache/cta/site/.openai/hosting.json`. It accepts `--build DIR`, `--snapshot DIR`, and `--output DIR` when another location is needed. Register the private Site once and persist its returned project ID in that staging directory's hosting manifest. Publish that directory with the Sites source and archive workflow.

The generated entry page selects snapshot mode with:

```html
<meta name="transit-snapshot" content="./snapshot/index.json" />
```

The normal application build continues to open the live dashboard. For local development, serve the generated reports at `snapshot/index.json` and open `?snapshot=cta`. Snapshot links use `#routes`, `#route/9`, and `#data`.

## What is published

The staging script copies the built interface plus only the snapshot files referenced by the index and route detail reports. It excludes the live engine, DuckDB, WebAssembly, raw Positions files, GTFS ZIPs, CSV intermediates, databases, and unreferenced reports. It checks each asset against the static host's 25 MiB file limit.

The Site includes derived route metrics, street geometry, and inferred stop-passage diagrams. Those reports are loaded when needed. Downloaded source archives and working data remain local. `.cache/` and `dist/` are ignored by Git; neither raw data nor the generated report bundle belongs in the application PR. The PR contains the reusable acquisition, normalization, export, loading, and packaging code and its checks.

The existing metric definitions and sample-size thresholds still apply. Schedule matching for CTA's Bus Tracker format is explained with the source provenance; it must not be presented as a direct GTFS realtime trip-ID join. Low-confidence schedule measures are withheld, and missing observations must not be interpreted as canceled service.

## Claude artifact

The same snapshot can also be published as a private Claude artifact. Stage it after `npm run build`:

```sh
npm run package:cta-artifact
```

This writes `.cache/cta/artifact/dist/` and `.cache/cta/artifact/manifest.json`. It accepts the same `--build`, `--snapshot` and `--output` options as the Site script and reuses its manifest validation, so only the reports the index references are staged.

The artifact host sets these constraints, and the staging script handles each one:

- **One page.** The host wraps the page in its own document, so the page has no `<html>`, `<head>` or `<body>`, and the built script and stylesheet are inlined into it. The display font is inlined as a data URI. The app reads the `transit-snapshot` meta tag from anywhere in the document, so snapshot mode works the same way it does on the Site.
- **Map.** The page's content policy blocks the OpenFreeMap tiles and glyphs, so the page carries `<meta name="transit-basemap" content="off">`. Maps then draw route geometry on the plain map background with no outside requests. The MapLibre worker is published next to the page, because the inline module resolves it relative to the page.
- **File types.** Artifacts do not serve gzip files. Trip diagram companions are staged as decompressed `.json` (about 174 MB), and each staged route report's `lines` path is updated to match.
- **Downloads.** The viewer's frame cannot start downloads. When the page runs inside an artifact, the CSV buttons go through the `downloads` capability and the viewer confirms each save. Publish with `capabilities: {downloads: true}`.
- **Size.** A publish carries at most 255 files and 64 MB, and a version at most 511 files and 256 MB. The manifest lists the publish batches with a 60 MB budget each. The first batch includes the page, the index and every route report, so the scorecard and route pages work after the first publish. Later batches add the remaining trip diagrams.

To publish, use the Artifact tool. Publish `dist/index.html` with `root` set to the staging `dist/` directory, `icon: "bus"`, the manifest's `capabilities`, and the first batch's `files`. Then publish each later batch's `files` to the returned `url`. Files already published stay in place.

Differences from the Site: there is no street basemap, and deep links such as `#route/9` do not pass through the artifact URL, because the host forwards only plain hashes like `#routes` and `#data`. Routes still open from the scorecard.
