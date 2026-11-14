# Transit operations data mart

DuckDB SQL that turns the [gtfsrt.io](https://gtfsrt.io/) archive of GTFS-Realtime snapshots, plus the GTFS schedules archived beside it, into reporting tables for transit operations: feed quality, trip delivery, on-time performance, headway regularity, prediction accuracy and alerts.

GTFS-Realtime defines how realtime data is exchanged. It does not define how to turn it into performance metrics. The SQL here is written to be read as that missing definition: each model states its grain, its rules, who is eligible to be counted and what happens when the feed says nothing. `meta_metric` holds the same definitions as data.

This is separate from the web app. The app analyses on the visitor's device with the Rust engine; the mart is a batch build with the DuckDB CLI, and a second implementation the app's numbers can be checked against.

## Run it

Requires the `duckdb` CLI (2.0) and Node 24. No DuckDB extensions are used.

```sh
# download what one service day needs, build every table, run the tests
node mart/run.mjs all --systems metro-transit-madison --dates 2026-11-04

# several systems and days
node mart/run.mjs all --systems metro-transit-madison,septa-rail --dates 2026-11-04,2026-11-05

# thin slice while developing: only captures between 14:00 and 17:00 local
node mart/run.mjs build --systems metro-transit-madison --dates 2026-11-04 --hours 14-17

# re-run from one model onward, or one model alone
node mart/run.mjs build --systems metro-transit-madison --dates 2026-11-04 --from 41
node mart/run.mjs build --systems metro-transit-madison --dates 2026-11-04 --only 51

node mart/run.mjs test
```

A system key is the archive's `agency_id`, with `-system_id` appended where an agency has several (`septa-bus`, `septa-rail`). Downloads go to `mart/data/archive`, mirroring the bucket's paths, and the database to `mart/data/mart.duckdb`. Both are git-ignored. Use `--db` to build into another file.

Then query the result:

```sh
duckdb mart/data/mart.duckdb -c "FROM rpt_system_day"
duckdb mart/data/mart.duckdb -c "FROM rpt_route_day ORDER BY scheduled_trips DESC"
duckdb mart/data/mart.duckdb -c "SELECT name, formula, eligibility, missing_data, limits FROM meta_metric"
```

## Layers

Files run in name order. Each table's grain is stated in a comment above it and enforced by `tests/50_grain_unique.sql`.

| File | Builds | What it settles |
| --- | --- | --- |
| `00_macros` | macros, `meta_threshold` | GTFS time and service-day arithmetic; every threshold in one table |
| `01_catalog` | `cat_feed`, `dim_system`, `plan_schedule`, `plan_object` | which schedule version is in force for each service day; which archive objects to read |
| `02_objects`, `03_enums` | file lists, `meta_enum` | which planned objects are on disk; labels for GTFS-RT enums |
| `10_stg_schedule` | `stg_*` schedule tables | the archive's all-text GTFS tables, typed; optional tables and columns tolerated |
| `20_schedule` | `dim_service_day`, `fct_scheduled_trip`, `fct_scheduled_stop_time`, `dim_route`, `dim_stop` | what was supposed to run on each service day, in UTC instants |
| `30_stg_realtime` | `stg_poll`, `stg_vehicle_position`, `int_tu_trip`, `int_tu_stop`, `stg_alert` | repeated captures reduced to the facts they state; each row given a service date |
| `31_feed_quality` | `fct_feed_poll`, `fct_capture_gap`, `mart_feed_day` | when the feeds were captured, and how fresh they were |
| `32_alert` | `fct_alert`, `fct_alert_entity`, `fct_alert_route_day` | each alert once, with the span the feed carried it |
| `40_stop_event_vp` | `fct_stop_event_vp` | stop events from map-matched vehicle positions |
| `41_stop_event_tu` | `fct_stop_event_tu` | stop events from the trip-updates feed's final times, graded by evidence |
| `42_stop_event` | `fct_stop_event`, `qa_stop_event_method`, `qa_stop_event_coverage` | both methods side by side, the method chosen per stop, and how far they disagree |
| `50_trip` | `fct_trip` | each trip's evidence and delivery status |
| `51_headway` | `fct_headway` | observed against scheduled headways |
| `52_prediction` | `fct_prediction_error` | prediction error histograms by horizon |
| `60_marts` | `mart_otp`, `mart_trip_delivery`, `mart_headway`, `mart_prediction`, `rpt_route_day`, `rpt_system_day` | additive sums, and report views that turn them into rates |
| `90_metric_registry` | `meta_metric` | every reported metric's formula, eligibility, missing-data rule and limits |

## Rules that hold everywhere

- **The service day is the unit.** Scheduled times count from noon minus twelve hours, local time, and may pass 24:00. Realtime rows are read from one hour before that origin to thirty hours after it.
- **Every realtime row gets a service date before anything is aggregated.** Many feeds leave `start_date` blank and reuse a `trip_id` every day. A reported date is believed when the row sits within four hours of the schedule on that date; otherwise the date whose scheduled time is nearest is used; with no schedule to check, the local date three hours back. The basis is kept on the row (`service_date_basis`).
- **Missing is not cancelled, and not late.** A trip with no evidence is `not_observed`. A stop with no event is left out of on-time performance. Neither is turned into a failure.
- **Capture comes first.** A trip is `is_measurable` only when the feeds were being captured across its scheduled span. Delivery rates count measurable trips, so an archive outage shrinks the denominator instead of reading as missed service.
- **Unreported routes are counted apart.** A route none of whose scheduled trips was observed that day (a subway line in a bus feed, a ferry, a route carried only under trip IDs the schedule lacks) is not measurable. Its trips go in `unreported_route_trips`, not in `not_observed`.
- **A cancellation must still stand.** A trip is `canceled` when the trip-updates feed's last word was CANCELED, or a NO_SERVICE alert naming the trip was still up at its scheduled end, and it was not seen at half its stops. `cancel_source` says which. Being listed in trip updates is never evidence a trip ran.
- **A delay is not a time.** Trip updates that give only a delay are never graded above an estimate, so they do not become stop events.
- **Methods are labelled, never blended.** A stop event comes from vehicle positions where they support one, else from trip updates where the feed's final time is graded `observed`. `event_method` says which, a headway never pairs events from two methods, and `qa_stop_event_method` reports how far the two disagree where both exist.
- **On-time performance is position-based.** `on_time_share` uses vehicle-position events only. Stops only trip updates could time are reported beside it as `tu_on_time_share` and never pooled in.
- **Marts are additive.** They store counts and sums. Rates are computed from merged sums in the report views, beside their n, and are withheld under 20 events and marked low under 100.

## Systems built so far

Madison Metro, King County Metro, SEPTA bus, SEPTA Regional Rail and Sound Transit, for service date 2026-11-04. What each feed does and does not state is recorded by the build itself in `qa_tu_feed_profile`, `qa_trip_id_match`, `qa_scheduled_trip_presence`, `qa_schedule_source`, `qa_stop_event_coverage` and `qa_stop_event_method`.

Sound Transit's realtime feed carries buses run for it by other agencies under their trip IDs. `cat_schedule_extra` (in `01_catalog.sql`) adds King County Metro's schedule to it, limited to Sound Transit's routes. Those trips then appear under both systems, so do not add the two systems together.

A full day for the five systems builds in about six minutes, nearly all of it reducing trip updates in `30_stg_realtime.sql`.

## Tests

`node mart/run.mjs test` runs every file in `mart/tests`. A test is a query that returns one row per violation. They check that each grain is unique, that the schedule is neither dropped nor multiplied by joins, that delivery statuses partition measurable trips, that `mart_otp` restates `fct_stop_event`, that events sit near the schedule and run forward along a trip, that the read window was actually captured, and that every reported rate has a registry entry.
