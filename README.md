# GTFS-RT browser dashboard feasibility

**Yes: a browser running the DuckDB 2.0.0 engine can query gtfsrt.io's public Parquet archive directly, without a data proxy.** Verified in Chrome on November 6, 2026 using a real Madison vehicle-position partition with 296,588 rows.

This repository currently contains a reproducible feasibility experiment and a proposed architecture, not the full dashboard.

- [Feasibility decision, evidence and caveats](docs/feasibility.md)
- [Dashboard architecture and specification](docs/architecture.md)
- [Rust packaging and browser security](docs/packaging-security.md)
- [Recorded browser results and HTTP requests](docs/evidence/browser-probe.json)

## Run the visible experiment

Requires Node.js and npm. The automated probe uses installed Google Chrome by default.

```sh
npm ci --ignore-scripts
npm run probe:serve
```

Open [the local probe](http://127.0.0.1:4173/spike/index.html). It fetches the archive directly from your browser and shows the engine version, connection checks and route aggregate results. The local server only serves application assets; it does not proxy transit data. Closing the tab stops its worker.

To save a fresh result with browser network evidence:

```sh
npm run probe
```

Use `CHROME_PATH=/absolute/path/to/chromium` for a different installed Chromium executable. The command updates `docs/evidence/browser-probe.json` and exits unsuccessfully when the probe fails. A fresh browser context is used, though shared network caches are outside the probe's control.

To reproduce the additional all-column sample run:

```sh
PROBE_QUERY='?sample=all' PROBE_OUTPUT=docs/evidence/all-columns-probe.json npm run probe
```

The visible page also accepts `?date=YYYY-MM-DD`; the default is the fixed, tested date `2026-11-05`. Each run downloads the WASM assets and archive data. This probe is deliberately limited to one known feed/day.

## Important implementation details

- SQL engine: **v2.0.0**. npm wrapper: **`@duckdb/duckdb-wasm@1.33.1-dev114.0`**, a prerelease package. They use different version numbers.
- Archive base: **`https://storage.googleapis.com/parquet.gtfsrt.io`**. The custom `https://parquet.gtfsrt.io` hostname failed certificate validation.
- Explicitly set both `allowFullHTTPReads: false` and `forceFullHTTPReads: false`; see the decision document for the reproducible default-setting failure.
- Range support does not guarantee a small download. The tested projected query sequence requested the entire 34.2 MB object, plus overlapping ranges.
- Counts represent archived observations. They are not completed trips, on-time performance, or a service-quality ranking.

Intended upstream repository: [MisterClean/gtfsrt-dashboard](https://github.com/MisterClean/gtfsrt-dashboard).
