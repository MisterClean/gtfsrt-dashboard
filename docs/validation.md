# Validation

How the numbers were checked, what the checks found, and what they don't prove. There's no ground truth here: the archive has no door events, passenger counts or street map, so these checks show agreement between methods and internal consistency, not accuracy against what happened on the street.

## Independent check

A separate AI review agent wrote a second implementation of the method, apart from the app's Rust code, and ran it on the same raw vehicle positions and schedules. It then compared results with the app and traced each disagreement back to the raw GPS. No person has audited these results yet. Figures are for service date 2026-11-04, shown as app / check.

| Measure | Madison | King County |
| --- | --- | --- |
| Trips scheduled | 1,672 / 1,672 | 12,939 / 12,939 |
| Trips observed | 1,653 / 1,653 | 11,924 / 11,934 |
| All-day speed, mph | 15.23 / 15.22 | 14.06 / 14.05 |
| 7 to 9 AM | 14.88 / 14.87 | 13.93 / 13.92 |
| 10 AM to 2 PM | 15.19 / 15.19 | 14.00 / 13.99 |
| 4 to 6 PM | 13.52 / 13.51 | 12.45 / 12.44 |
| On time | 69.7% / 69.8% | 73.0% / 73.1% |
| Bunched | 2.86% / 2.82% | 2.40% / 2.40% |
| After a gap | 11.08% / 11.08% | 11.52% / 11.47% |
| Stop events compared | 64,901 | 390,433 |
| Median and 99th percentile difference | 0 s, 3 s | 0 s, 1 s |
| Events over 60 s apart | 55 | 260 |
| Events over 300 s apart | 1 | 94 |

On Madison, every route's all-day speed is within 0.8% of the check. On King County, the median route is within 0.12%, 90% are within 0.49%, and the largest gap is 2.91%. On-time performance differs by more than two points on one Madison route, Route S, whose buses don't follow the published shape, and on 5 of 111 King County routes with 100 or more passes.

### What it found

The check found real defects, which is why it's worth having. All of these are fixed.

| Problem | Effect | Fix |
| --- | --- | --- |
| A late vehicle matched to the wrong pass of a line | Lost some of the worst trips, flattering on-time performance | Every pass is followed through the whole run, and the best explanation wins |
| GPS noise jumped a vehicle to the return leg | Stop passes recorded too early or too late | The earliest pass within 25 m of the best fit wins |
| Layovers on loop routes counted as headways | Routes that never run frequently showed bunching and gaps | Same-vehicle pairs and last-stop arrivals are excluded |
| Stop spikes drawn into shapes | Madison read about 1.2% fast, and nearly 5% on routes with many stops | Spikes are removed before measuring |
| A heading filter, added while fixing the second problem | A bus creeping back to its stop during layover read as a false departure | Removed after the check showed net harm |
| Feeds dating after-midnight trips by calendar day | Cleveland's late trips landed a full day off, with 5,831 events over 12 hours from schedule. Now 0 | A reported date only counts near that date's scheduled window |
| Stops that fit two passes equally | One King County stop read 35% on time rather than 56% | Near-ties go to the earlier pass |

Madison events over 60 s from the check fell from 106 to 55, and those over 300 s from 22 to 1. On Madison, the remaining differences are mostly Route S.

### Line geometry

Distance along a line, divided by straight-line GPS distance on straight road. A correct line gives the same ratio with and without a published stop jump in the pair.

| Feed | Line | No jump | Jump |
| --- | --- | ---: | ---: |
| Madison | Raw | 1.0053 | 1.0329 |
| Madison | Cleaned | 1.0049 | 1.0049 |
| Missoula | Raw | 1.0031 | 1.0629 |
| Missoula | Cleaned | 1.0027 | 1.0019 |

The spike rule fires where shapes have spikes and stays nearly idle elsewhere. It removes 3.03% of line length in Missoula, 1.14% in Madison, 0.026% at AC Transit, 0.013% at SEPTA, 0.005% at VTA, 0.004% in Cleveland and 0.001% in King County.

Stop positions against published distances: the 99th percentile is 6.0 m in Madison, 5.3 m at AC Transit and 7.1 m in King County, with 0, 0 and 3 stops more than 50 m off.

### GPS-only speeds

Measured on the same reports as the schedule-joined figures.

| Measure | Madison | King County |
| --- | --- | --- |
| Network, GPS-only against joined | 13.66 against 15.23 mph | 13.33 against 14.06 mph |
| Network difference | 10% low | 5% low |
| Single routes | 22% to 5% low | 26% low to 9% high |
| Rank correlation across routes | 0.96 | 0.99 |

Rankings between routes hold up, but the difference varies too much for a single correction factor. Use GPS-only speeds to compare routes and times of day, not as absolute figures.

## Every agency in the archive

Every vehicle-position feed in the archive, each on its newest day that the app offers by default. This ran the production build in headless Chromium, under its real security policy, with a clean browser profile for each feed. All 21 finished with no errors and nothing in the console.

| Feed | Day | Source files, MB | Time, s | Speed, mph | Scheduled, mph | On time | Trips observed | Peak vehicles |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| AC Transit | 2026-11-04 | 39 | 16 | 12.5 | 12.8 | 67.9% | 4,585 of 5,145 | 362 |
| Big Blue Bus | 2026-11-04 | 80 | 18 | 10.2 | — | GPS only | — | 119 |
| Broward County Transit | 2026-07-21 | 64 | 17 | 14.9 | 14.6 | 80.8% | 2,166 of 2,518 | 211 |
| Butler County RTA | 2026-11-04 | 50 | 16 | 18.3 | 16.4 | 80.3% | 472 of 479 | 23 |
| CATS (Charlotte) | 2026-11-04 | 88 | 20 | 17.4 | 16.6 | 75.6% | 2,477 of 3,294 | 160 |
| CityBus (Lafayette) | 2026-11-04 | 68 | 16 | 15.4 | 15.2 | 72.8% | 932 of 962 | 30 |
| Dayton RTA | 2026-11-04 | 78 | 21 | 18.4 | 18.0 | 75.4% | 1,070 of 1,088 | 79 |
| DDOT (Detroit) | 2026-11-04 | 84 | 20 | 15.1 | — | GPS only | — | 182 |
| Greater Cleveland RTA | 2026-11-04 | 129 | 23 | 15.5 | 15.7 | 77.8% | 3,455 of 3,642 | 241 |
| King County Metro | 2026-11-04 | 161 | 25 | 14.1 | 13.9 | 73.0% | 11,924 of 12,939 | 884 |
| Metro Transit (Madison) | 2026-11-04 | 68 | 18 | 15.2 | 15.1 | 69.7% | 1,653 of 1,672 | 131 |
| Metro Transit (Minneapolis) | 2026-11-04 | 175 | 28 | 15.2 | 15.9 | 75.1% | 6,828 of 8,028 | 602 |
| Metrolink | 2026-11-04 | 40 | 14 | 25.8 | 32.8 | 57.5% | 178 of 178 | 29 |
| Mountain Line (Missoula) | 2026-11-04 | 60 | 16 | 15.5 | 13.2 | 81.1% | 532 of 594 | 19 |
| MTA bus | 2026-11-04 | 446 | 53 | 8.2 | 8.5 | 45.8% | 51,540 of 55,159 | 4,538 |
| NYC Ferry | 2026-11-04 | 46 | 14 | 12.8 | 13.1 | 71.3% | 300 of 311 | 25 |
| SEPTA bus | 2026-11-04 | 316 | 33 | 12.0 | 12.9 | 57.7% | 12,048 of 14,906 | 972 |
| SEPTA Regional Rail | 2026-11-04 | 74 | 18 | 22.9 | 23.4 | 61.3% | 572 of 634 | 75 |
| Sound Transit | 2026-11-04 | 81 | 20 | 26.6 | 31.3 | 87.9% | 648 of 726 | 61 |
| VTA | 2026-11-04 | 141 | 22 | 14.6 | 14.1 | 72.2% | 3,359 of 3,955 | 324 |
| WRTA (Youngstown) | 2026-11-04 | 49 | 16 | 16.8 | — | GPS only | — | 36 |

- **These haven't all been independently checked.** Only Madison and King County got the full comparison, with partial checks on others listed below. For the rest, this shows the app runs and the results look plausible.
- **Times include downloads.** They come from one laptop on one connection, so read them as a rough guide. Source files is the size of the archive files covering the day. Range requests skip the pages an analysis doesn't need, so the actual download is somewhat smaller.
- **Three feeds are GPS only.** DDOT has no schedule in the archive. WRTA matches about 3% of trip IDs and Big Blue Bus none, so both fall back. Each page says so. DDOT also says its time zone was estimated from vehicle positions.
- **Sound Transit matches 39% of its reports** but observes 648 of 726 scheduled trips, so it keeps the schedule join and notes that some trips were left out.

## What wasn't checked

- **Partial checks:** AC Transit, Missoula, SEPTA, VTA and Cleveland got specific checks only, such as the spike rule or service dates. On-time performance and speed for Cleveland aren't validated, and SEPTA and VTA stop positions weren't checked. Cleveland also has 135 events over two hours off schedule that nobody has examined.
- **One day:** the comparison covers one weekday. A daylight-saving date, a holiday and the four-hour date rule on a real holiday are untested against raw data.
- **The browser path:** the comparison ran on the same Rust code natively. Browser results were confirmed to match on headline figures, not event by event.
- **Browsers:** all browser testing used Chromium. Safari, Firefox, Edge and low-memory devices are untested.
- **Known limits** are listed in the [metrics reference](metrics.md#known-limits).

## Reproducing a day without a browser

`crates/core/examples/replay.rs` runs a service day natively from CSV exports. Download the schedule tables and the vehicle position files covering the day, then export them with the DuckDB CLI:

```sh
for t in agency routes stops shapes calendar calendar_dates trips stop_times; do
  duckdb -c "COPY (SELECT * FROM read_parquet('$t.parquet')) TO 'out/$t.csv' (HEADER, DELIMITER ',')"
done

duckdb -c "COPY (
  SELECT epoch(fetch_timestamp) AS fetch,
         COALESCE(NULLIF("timestamp", 0), epoch(fetch_timestamp)) AS ts,
         latitude AS lat, longitude AS lon, trip_id, vehicle_id, route_id,
         start_date, start_time, COALESCE(occupancy_status, -1) AS occupancy
  FROM read_parquet(['day1.parquet', 'day2.parquet'])
) TO 'out/fixes.csv' (HEADER, DELIMITER ',')"

cargo run --release -p transit-core --example replay -- out 2026-11-04 -6
```

The last argument is the agency's UTC offset in hours on that day. A service day usually spans two UTC files, so export both.
