# Decision: direct browser access is feasible

Verified November 6, 2026. **GO for a bounded browser explorer using DuckDB engine 2.0.0. Broad service benchmarking remains conditional on workload and metric validation.**

An ordinary Chrome browser loaded DuckDB-Wasm, fetched the archive catalog with browser CORS enforcement, and ran SQL against an HTTPS Parquet object directly. No transit-data proxy, credentials, native DuckDB process, disabled browser security or predownloaded local data file was used. The local Node server served JavaScript/WASM assets only.

## What ran

| Property | Measured value |
| --- | --- |
| Browser | Google Chrome 157.0.8103.39, macOS; also passed in the visible in-app Browser |
| SQL engine | `SELECT version()` returned `v2.0.0` |
| JavaScript package | `@duckdb/duckdb-wasm@1.33.1-dev114.0` |
| WASM bundle | `duckdb-base.wasm` + `duckdb-browser-base.worker.js` |
| Isolation / threads | `crossOriginIsolated = false`; one worker/thread |
| Database memory setting | 512 MB configured; total browser memory was not measured |
| Source | Metro Transit – City of Madison vehicle positions |
| Partition | Fetch UTC day `2026-11-05` |
| Parquet object | 34,180,170 bytes |
| Records | 296,588 snapshot rows |
| Route computation | Count snapshots, distinct reported vehicle IDs, earliest/latest fetch, grouped by route |
| Route example | Route D: 34,713 snapshot rows, 29 distinct reported vehicle IDs |
| Quality example | 40,990 rows had a null route ID |
| Other successful reads | `inventory.json`, `feeds.parquet`, `schedules.json` |

The [recorded successful run](evidence/browser-probe.json) began at 18:15:11 UTC and ended at 18:15:19 UTC. The route aggregation step took 2.80 seconds after preceding schema/count queries. Total run time was about 8.4 seconds. These are one-machine observations, not cold-query latency guarantees; setup and earlier reads affect cache state.

SQL executed against the registered remote file:

```sql
SELECT route_id,
       count(*) AS snapshot_rows,
       count(DISTINCT vehicle_id) AS distinct_reported_vehicles,
       min(fetch_timestamp) AS first_fetch,
       max(fetch_timestamp) AS last_fetch
FROM read_parquet('madison.parquet')
GROUP BY route_id
ORDER BY snapshot_rows DESC
LIMIT 10;
```

The row-count query alone could have used Parquet metadata. The aggregate additionally read actual route, vehicle and timestamp columns, so the proof is stronger than a successful HEAD request or metadata count.

## Version mapping matters

The core engine's [2.0.0 release](https://duckdb.org/2026/10/21/announcing-duckdb-200) and the npm wrapper do not share a version number. The exact npm `@duckdb/duckdb-wasm@2.0.0` endpoint returned 404. At investigation time, npm `latest` pointed to `1.33.1-dev57.0`, while `next` pointed to the tested `1.33.1-dev114.0`. Do not install an unpinned tag expecting a particular engine.

The tested package's source revision is `deb938860faf52dec5e8b5dbcc7371858c15e9e4`. Its [DuckDB submodule](https://api.github.com/repos/duckdb/duckdb-wasm/contents/submodules/duckdb?ref=deb938860faf52dec5e8b5dbcc7371858c15e9e4) points to `d54cbbe3df17e8e5ce68312f483b4155836112aa`, matching the [core v2.0.0 tag](https://api.github.com/repos/duckdb/duckdb/git/ref/tags/v2.0.0). The browser's SQL version check is the decisive runtime verification.

Treat the prerelease wrapper as a compatibility dependency: pin it and the lockfile, then rerun the gate before upgrading. The package distributes `base` and `threads` assets; older documentation examples using `mvp`, `eh` and `coi` filenames do not match these installed assets.

## Working browser configuration

The complete implementation is in [the probe](../spike/probe.mjs). Its essential setup is:

```js
const worker = new Worker('/node_modules/@duckdb/duckdb-wasm/dist/duckdb-browser-base.worker.js');
const db = new duckdb.AsyncDuckDB(logger, worker);
await db.instantiate('/node_modules/@duckdb/duckdb-wasm/dist/duckdb-base.wasm');
await db.open({
  maximumThreads: 1,
  filesystem: {
    allowFullHTTPReads: false,
    forceFullHTTPReads: false,
    reliableHeadRequests: true,
  },
});
await db.registerFileURL('madison.parquet', archiveObjectURL, duckdb.DuckDBDataProtocol.HTTP, false);
const conn = await db.connect();
await conn.query("SET memory_limit = '512MB'");
```

The library and its Arrow dependency are bundled by esbuild. In a deployed application, copy matching worker/WASM assets to public paths rather than exposing `node_modules` generally.

No explicit `INSTALL httpfs` or `LOAD httpfs` was required for the successful registered-URL path. Native DuckDB snippets from the archive homepage are not sufficient browser setup instructions. DuckDB documents browser file registration in its [data ingestion guide](https://duckdb.org/docs/2.0/clients/wasm/data_ingestion).

**Do not omit `forceFullHTTPReads: false`.** The pinned build interprets an unspecified value as true in its [filesystem implementation](https://github.com/duckdb/duckdb-wasm/blob/deb938860faf52dec5e8b5dbcc7371858c15e9e4/lib/src/io/web_filesystem.cc#L367). Combining that default with `allowFullHTTPReads: false` disabled both paths and produced “Failed to open file.” The [failed experiment](evidence/registered-url-failure.json) preserves this finding. Explicit settings resolved it without changing the archive or introducing a proxy.

## HTTPS, CORS and partial reads

Use the public bucket endpoint:

```text
https://storage.googleapis.com/parquet.gtfsrt.io/
  vehicle_positions/date=2026-11-05/
  base64url=aHR0cHM6Ly9tZXRyb21hcC5jaXR5b2ZtYWRpc29uLmNvbS9ndGZzcnQvdmVoaWNsZXM/
  data.parquet
```

Join those lines without whitespace. Preserve the catalog's base64url feed key.

- A browser HEAD returned 200 with a readable `Content-Length`.
- A browser GET with `Range: bytes=0-3` returned 206 and `PAR1`.
- DuckDB's ranged HEAD returned 206; subsequent GETs returned 206.
- Successful responses carried `Access-Control-Allow-Origin: *`.
- `Content-Range` was visible to the browser test harness's network observer, but **not** to ordinary page JavaScript. The page recorded `null`; this did not prevent this DuckDB path working.
- The custom HTTPS hostname `parquet.gtfsrt.io` failed TLS hostname validation. The homepage's HTTP URLs would also be unsuitable for an HTTPS application. No certificate checks were bypassed.

These are endpoint observations, not a guarantee that every archived object exists or that server policy will remain unchanged.

## Range support does not establish efficient pruning

For the successful projected-query sequence, the recorded Madison GET response lengths sum to **36,509,848 bytes** across 15 range responses, including the four-byte format probe. Merged response ranges cover the **entire 34,180,170-byte object**, with overlapping reads. An [additional run including two all-column sample rows](evidence/all-columns-probe.json) had the same summed lengths.

This measurement sums HTTP response `Content-Length`, not wire-level traffic. It excludes HEAD bodies (none), protocol overhead and the 33,753,922-byte uncompressed WASM asset. Browser/network caches can affect actual transferred bytes. The per-phase network labels are approximate, because worker requests and console events are asynchronous. See [the transfer summary](evidence/transfer-summary.json).

An independent eight-byte trailer read found a **14,066,633-byte Parquet footer** (roughly 41% of this object). Its size helps explain why even metadata work is substantial; exact causes and tuning require further file-layout profiling. The complete query sequence does not establish which part of the remaining scan came from projection, cache prefetch or file layout.

Consequently, do not promise that selecting one route or a narrow time range makes downloads small. Enforce feed/day/object-size budgets, profile real workloads, and consider compact aggregate files for longer periods or many agencies.

## What the gate does and does not establish

**Established:** the requested DuckDB 2.0.0 engine can consume this archive directly in a browser; the public catalog, feed metadata and schedule catalog are accessible; real Parquet data can be grouped and counted with normal CORS rules.

**Still to validate before product release:** other browsers and constrained-memory devices; additional agencies and feed types; a hosted HTTPS deployment; cancellation and peak memory; missing partitions and schema evolution; historical static-table joins; actual service-event inference; multiagency workloads and performance targets. No claim of on-time performance or delivered-service comparability follows from this probe.

The [architecture](architecture.md) therefore starts with a static SPA, one DuckDB worker and a bounded city selection. It retains direct archive access, with optional precomputed public Parquet aggregates for broad benchmarking. Historical static schedules already exist in the archive, but matching and metric quality remain explicit acceptance gates.
