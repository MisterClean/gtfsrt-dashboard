# CTA bus snapshot inputs

The snapshot selects the 20 elapsed weekdays from October 13 through November 9, 2026 in `America/Chicago`. The archive's latest published bus file at capture was November 9. November 10 was still in progress. The raw weekday files contain 24,367,347 reports and total 293,603,424 bytes.

## Source versions

- Positions are CTA Bus Tracker observations from Chicago Transit Alerts. The Positions index pointed to the schema v2 manifest generated November 10, 2026 at 08:40:01 UTC. The build pins manifest SHA-256 `1300d4d5dba9025f7c9da62a9b57f7e5b5efac3ddf45a63ef27586c43ee5b925` and verifies the SHA-256, bytes, report count, and poll counts and bounds of each input file. The manifest groups reports by local calendar date. [Publisher documentation](https://chicagotransitalerts.app/subscribe/#use-the-data) · [Positions index](https://data.chicagotransitalerts.app/positions/index.json) · [Pinned manifest](https://data.chicagotransitalerts.app/positions/manifests/1300d4d5dba9025f7c9da62a9b57f7e5b5efac3ddf45a63ef27586c43ee5b925.json)
- The schedule is the September 16, 2026 archived CTA GTFS release from Mobility Database feed `mdb-389`. The listing shows coverage from September 11 through November 30. ZIP SHA-256 `a9372be5b70fcee4ed98c9476433f86065637a9a500b8af6afbb84d000ef2746`. The preparation script keeps GTFS bus routes (`route_type = 3`), trips active on at least one selected date after applying calendar exceptions, and the shapes, stops, and stop times those trips reference. [Mobility Database listing](https://mobilitydatabase.org/feeds/gtfs/mdb-389) · [Pinned GTFS ZIP](https://files.mobilitydatabase.org/mdb-389/mdb-389-202609160157/mdb-389-202609160157.zip)

## Coverage

All 20 weekday partitions were published. The publisher documented nine affected dates:

| Local date | CTA bus collection issue |
| --- | --- |
| Oct. 13 | Request limit reached at 2:30 p.m. |
| Oct. 14 | Request limit reached at 1:34 p.m. |
| Oct. 15 | Request limit reached at 1:13 p.m. |
| Oct. 16 | Request limit reached at 1:19 p.m. |
| Oct. 22 | No polls from 3:37 to 3:48 p.m. |
| Oct. 30 | No polls from 5:40 to 6:07 p.m. |
| Nov. 3 | Deployment interruption at 3:28 p.m. |
| Nov. 4 | Reduced polling from 9 a.m. through midnight. |
| Nov. 5 | Reduced polling for parts of the morning and early afternoon. No polls from 2:36 to 4:37 p.m. |

The snapshot retains these dates. Positions from the following local calendar day can contribute when they carry the selected GTFS service date. The November 10 partition was unavailable, so service that continued past midnight on November 9 has incomplete coverage. Typical archive poll intervals were about 60 seconds on the selected October dates and 30 seconds in November. Counts of raw reports should be interpreted with that change in cadence in mind. [Archive gap records](https://data.chicagotransitalerts.app/positions/manifests/1300d4d5dba9025f7c9da62a9b57f7e5b5efac3ddf45a63ef27586c43ee5b925.json)

## Schedule matching

The Bus Tracker archive carries route, pattern, destination, and scheduled departure fields. The exporter uses those fields to infer the scheduled trip. It first requires the exact route, active service date, and scheduled first-stop departure. If the reported pattern exists for that route and date, the exporter requires a unique candidate with that pattern, using the numeric five-digit suffix of the eight-digit CTA shape ID. An unrecognized numeric pattern can match only when exactly one candidate has a matching first or last nonempty GTFS stop headsign. Ambiguous candidates remain unmatched. The native analytics engine then map-matches the observed coordinates and computes the existing speed, headway, and schedule metrics. [CTA GTFS and Bus Tracker distinctions](https://www.transitchicago.com/developers/gtfs/) · [Transit Almanac metrics](metrics.md)

An independent DuckDB calculation found 22,222,636 eligible reports matched out of 24,336,333, or 91.31%. This includes 21,734,623 exact pattern matches and 488,013 unique headsign matches. Daily match coverage ranged from 90.04% to 92.78%. The denominator uses the report's GTFS service date and the applicable overnight cutoff, so it differs from the sum of raw weekday partitions. The independent calculation and native export agreed on match rates and scheduled trip counts on all 20 dates. There were 124 scheduled routes on each selected date and 385,776 scheduled trips in total, or 19,264–19,297 per day. Route 19 was present in the position archive with 4,456 reports and had no corresponding route in the pinned schedule.

| Unmatched reason | Reports |
| --- | ---: |
| No trip at the exact scheduled departure | 2,017,383 |
| Active pattern disagreed with candidates at the exact departure | 90,292 |
| No active scheduled route | 4,456 |
| Multiple headsign candidates at the exact departure | 1,566 |

On November 9, Route 9 had 363 scheduled trips and the native exporter measured 10.68 mph. The independent check summed 4,141.38 miles of Bus Tracker pattern-distance changes over 389.20 vehicle hours across 45,092 filtered consecutive reports, giving 10.64 mph. The independent check uses the tracker's reported pattern distance. The exporter measures progress projected onto the GTFS shape.

## Rebuild locally

From the repository root, with Node 24+, curl, unzip, DuckDB, the project's Rust toolchain, and gzip installed:

```sh
node scripts/cta-source.mjs
cargo run --release -p transit-core --example export_cta_snapshot -- .cache/cta .cache/cta/snapshot
```

Preparation writes the immutable downloads, normalized CSVs, and coverage metadata under `.cache/cta/`. Budget about 5 GB of local disk for the inputs and intermediates. See the [Site staging instructions](cta-site.md) for packaging the derived outputs.
