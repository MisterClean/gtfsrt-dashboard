# Loading performance

Measured with `scripts/bench-load.mjs`: one service day (Fri 2026-11-06), cold browser profile, built release served with production headers, a home connection (about 50 MB/s, 100 ms round trips). One run per feed, so treat differences under a second as noise.

| Feed | Before | After | Archive MB read (before / after) | Archive GETs (before / after) |
|---|---|---|---|---|
| Madison | 14.4 s | 10.6 s | 70 / 63 | 64 / 19 |
| Metrolink | 9.1 s | 6.8 s | 38 / 36 | 43 / 16 |
| Sound Transit | 14.9 s | 10.3 s | 73 / 75 | 51 / 20 |
| Big Blue Bus | 13.6 s | 10.1 s | 72 / 72 | 48 / 20 |
| NYC Bus | 41.1 s | 25.4 s | 251 / 251 | 221 / 99 |

## What helped

- **Schedule tables fetched whole, in parallel, ahead of need** (18 s to 3.8 s for NYC Bus, 3.3 s to 0.5 s for Madison). One GET per table replaces HEAD, footer read, DESCRIBE and query in a strict sequence per table and per source. They arrive while the first archive file is being read.
- **Archive files of 96 MB or less are downloaded whole in parallel 8 MB ranges**, one file ahead of the one being decoded. DuckDB's own HTTP reads are synchronous and ramp up from 16 KB, about 28 round trips for a 34 MB object. The same bytes arrive in about 0.6 s this way. Larger objects (NYC Bus, 165 and 221 MB) are still read in place, because row-group pushdown skips about a third of them and a whole download would cost more on a slow link.
- **Trips, stops and the small tables are read as Arrow columns** instead of an object per row.
- **JSON metadata** (`inventory.json`, `schedules.json`) is kept for five minutes in the worker, then revalidated with its ETag. `schedules.json` is fetched while the database starts.

## What is left

DuckDB's CPU is now the floor: about 1.2 s to read each object's footer (14 MB for Madison: one row group per poll) and 2 to 3 s to decode a window, per file, on one thread. `SET parquet_metadata_cache = true` does not exist in this build. NYC Bus spends 5 s in the Rust day processing and 3.8 s compiling six schedule sources.

## Does the archive support pushdown?

Yes. Files are sorted by fetch time with one row group per poll, and the footer carries each group's min and max. A window query reads from the middle of the object (Madison 11-06 starts at byte 5.0 MB of 19.7 MB of data), and NYC Bus read 251 MB of 386 MB. The footer is a fixed cost, 14 MB of Madison's 34 MB. DuckDB's read-ahead overshoots the end of the data into the footer.
