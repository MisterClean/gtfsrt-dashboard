# Metric reference

This is the definition of every number in Transit Notebook: what it measures, how it is calculated, what it needs, and where it can mislead. It is written for transit planners and matches the code in `crates/core/src`. When a calculation changes, `METRIC_VERSION` in `cube.rs` goes up and browsers re-analyze their saved days.

The speed method comes from the [CTA Bus Speed Scorecard](https://michaelmclean.me/cta-bus-speed-scorecard). Its thresholds are carried over and tagged `[T1]` to `[T8]`. The scorecard could use CTA Bus Tracker's own distance along a pattern. GTFS-RT feeds don't have that, so this app adds map-matching and generalizes the method to any feed in the [gtfsrt.io](https://gtfsrt.io/) archive.

## How to read these numbers

- **Vehicles, not riders.** The archive has no ridership. Every average is weighted by distance, time or trips. A slow block with few riders counts the same as a crowded one.
- **Inferred, not observed, at stops.** The archive has no door-open events or confirmed arrivals. Stop times are interpolated from position reports.
- **Polling limits precision.** Feeds report every 20 to 60 seconds. One stop pass is an estimate. Averages over many passes are what to read closely.
- **Missing is not cancelled.** A trip absent from the feed may be cancelled, or it may be a reporting failure. This app reports trips observed and never trips cancelled.
- **Coverage first.** An archive outage lowers trip counts and lengthens headways. Check Coverage on the Data & methods page before trusting a surprising day.

Reports calculate in meters and seconds. The interface converts to mph or km/h.

## Time

### Service day

- **Definition:** The GTFS service date a trip belongs to, not the calendar or UTC date of its reports.
- **Origin:** Scheduled times count from noon minus twelve hours on the service date. A trip can run past 24:00:00, and daylight-saving days line up.
- **Service hour:** Seconds from the origin divided by 3,600, from 0 to 29. Hour 25 reads as 1 AM on the following calendar day. Charts show hours 4 to 27.
- **Time zone:** `agency_timezone` from the schedule, read through the browser's own time zone database. A feed with no schedule at all gets a zone estimated from the longitude of its vehicles, and the app says so on every day it affects. The estimate can be wrong in Arizona, Alaska and Hawaii, and any later schedule replaces it.
- **Reading the archive:** Archive files are split by UTC day, so one service day overlaps two files. Five consecutive weekdays read six files in a North American time zone, and each is read once. A day's read window runs 30 hours from its origin.
- **Incomplete days:** The newest day in the archive lacks its evening until the next UTC file is published, and a file can be missing from the archive altogether. When either cuts into a day's scheduled service, the day is marked partial, the app names the missing hours, and the day isn't saved, so it is read again next time. A day with no rows at all isn't treated as a result. It says so and stays out of every average.

### Assigning a run to a service date

A run is one vehicle on one reported trip descriptor. A new run starts after three hours without a report.

1. If the feed reports `start_date` and the run falls within four hours of the trip's scheduled window on that date, that is the service date. Some feeds report the calendar date on after-midnight trips, which would put them a full day off.
2. Otherwise the app considers the local date and the days either side, keeps those on which the trip's service is active, and picks the one whose scheduled window is nearest the middle of the run.
3. A run more than four hours from every such window is not counted for that trip.

A run the feed dates to a day when the calendar has no service, at that trip's usual time of day, is believed: holiday and special service often look like this. It counts as observed but not scheduled, so the observed share can pass 100% on such a day. A feed with no `start_date` can't make that claim, so the same run is counted under "no service date" instead.

### Time periods

| Period | Service hours | Used for |
| --- | --- | --- |
| Morning peak | 7:00 to 9:00 | Route scorecard, peak speed |
| Midday | 10:00 to 14:00 | Reference for peak change |
| Evening peak | 16:00 to 18:00 | Route scorecard, peak speed |

These match the CTA scorecard. Peak means the morning and evening peaks together. Stop-level rollups use five coarser groups: up to 7:00, 7:00 to 9:00, 9:00 to 16:00, 16:00 to 18:00, and 18:00 onward.

## Placing vehicles on the route

### Schedule version

For each service date, the app chooses the most recently retrieved version whose advertised dates cover the day and which was retrieved on or before it. Missing feed dates count as open-ended. If only a later capture covers the day, the earliest such capture is used and flagged. When an agency publishes several schedule sources, a version is chosen from each. If any source has no covering version, the day falls back to GPS speeds, and the app says so.

### Patterns

Trips with the same shape, route, direction and stop list form one pattern. A trip with no shape gets a straight-line path through its stops, which is marked as synthetic. Blank stop times are interpolated by distance between the known times either side.

### Map-matching

Each position report is projected onto the pattern's line.

| Step | Rule |
| --- | --- |
| First report | Any point on the line within 120 m. When the line passes there more than once, each pass is followed through the whole run. The one with the fewest off-route reports wins, then the most progress, and only a real tie goes to where the schedule expects the vehicle. Choosing by the schedule alone would send a late vehicle to the wrong pass and lose exactly the worst trips. |
| Later reports | The best fit between 60 m behind the last position and `80 mph × elapsed + 200 m` ahead (150 mph on rail and ferry routes). The earliest pass within 25 m of the best fit wins, so GPS noise can't jump a vehicle to a return leg. Within 300 m of the end of the line, the best fit in the next 150 m is then used, so a terminal hook is reached rather than stopped short of. |
| Off route | A report more than 120 m from the line is skipped and counted. |
| Forward only | Progress never decreases. A report landing behind the furthest point is held there, and one landing more than 30 m behind is counted. |

Distances use a local flat projection for each line, which is accurate well within one percent over the length of a route.

Line length is measured after removing **stop spikes**. Some agencies draw each shape out to the stop's curb position and back, and a vehicle doesn't drive those detours. A spike is a turn of 75° or more between two segments of up to 30 m, where the road carries on within 45° of the same direction beyond it. That last test keeps real corners and U-turns. In Madison, leaving spikes in read 1.3% fast overall and nearly 5% on routes with many stops. An independent check against straight-line GPS distance on straight roads confirmed the cleaned line in the validation.

### Stop positions

Stops are placed along the line by dynamic programming over every pass of the line near each stop. The result keeps stops in order and minimizes their total distance from the line. Distances are measured on the line rather than taken from `shape_dist_traveled`, whose units vary between agencies.

## Speed

### Operating speed

- **Definition:** How fast vehicles cover the route while in service, including time at stops, at signals and in traffic. This is the time a rider spends on board.
- **Formula:** `total distance along the line ÷ total elapsed time`, summed over intervals between consecutive reports. It is a space-mean speed, not an average of interval speeds.
- **Unit:** mph or km/h.
- **Data needed:** Vehicle positions with a trip ID that matches the schedule, and shapes.
- **Hour assignment:** `[T8]` Each interval belongs to the hour of its midpoint.

An interval must pass these rules to count.

| Tag | Rule | Threshold | Why |
| --- | --- | --- | --- |
| `[T1]` | Layover trim | Measured from the first report more than 500 ft (152.4 m) past the trace's start, keeping the interval that crosses out of that zone, up to the first report within 500 ft of its furthest point | Vehicles waiting at the ends of a line on purpose aren't running slowly |
| `[T2]` | Standstill | A run of intervals each moving at most 100 ft (30.48 m), totalling at least 10 minutes, is removed | Breakdowns, holds and parked vehicles. Ordinary stop and signal time stays |
| `[T3]` | Reporting gap | Intervals over 180 s are removed | Speed across a long silence is a guess |
| `[T4]` | Backward moves | Progress is held at the furthest point rather than the interval being removed | GPS jitter would create false reverses and false bursts of speed |
| `[T5]` | Geometry | Progress must be at most `2 × straight-line GPS distance + 1,500 ft (457.2 m)` | A match that jumped ahead with no movement behind it |
| `[T6]` | Speed backstop | Over 80 mph (35.8 m/s) is removed, or 150 mph (67 m/s) for rail and ferry | A last check against bad data |
| `[T7]` | Short patterns | Not applied | The scorecard dropped short connector and rare patterns. A planner reviewing one route needs to see them |

Each removed interval counts under the first rule that caught it. The counts are in the funnel on the Data & methods page.

**Known limits:** Speed reflects where and when service runs. A route's all-day figure mixes its patterns and hours, so use period speeds to compare times of day. A segment at a terminal can reflect a vehicle turning around. It isn't a door-to-door trip time, which would also need walking and waiting.

**Compared with common practice:** Agency reports often use revenue miles over revenue hours, which include scheduled layover and come out lower than this figure. Compare this figure with scheduled speed below, or with other results from this app, not directly with an NTD-style revenue speed.

### Scheduled speed

- **Formula:** `distance between consecutive stops ÷ (next stop's arrival − this stop's departure)`, summed over the day's active trips and assigned to the hour of each hop's midpoint.
- **Known limit:** Where a schedule gives different arrival and departure times at a stop, that scheduled dwell is excluded, while measured speed includes dwell. On schedules with long holds, this makes scheduled speed look somewhat faster than a true like-for-like comparison.

### Street segments

Speeds on the map and along a route are kept per directional street segment, which is stable across schedule versions.

- **Key:** route, direction, a grid cell of about 200 m, and one of eight 45° compass sectors.
- **Grid:** Latitude steps are 200 m. Longitude steps come from the agency's latitude rounded to a whole degree, so every schedule version lands on the same cells.
- **Slivers:** A run under 40 m joins the segment before it.
- **Allocation:** An interval's distance and time are split across the segments it crossed, assuming constant speed within the interval. A vehicle standing still puts all its time in one segment, which is where the delay happened.
- **Display threshold:** A segment's value needs at least 2 measurements, and at least one for each selected day. The CTA scorecard's map used the same one-a-day rule. A measurement is one interval overlapping the segment, and a bus crossing a segment at 20 s polling gives about two.
- **Map pooling:** The network map pools every route through the same cell and sector. Selecting a route limits it to that route.

### Period speeds on fixed segments

- **Why:** Some trips run only at certain hours. A rush-only trip into slow downtown blocks would look like congestion if measurements were simply pooled by period.
- **Formula:** Using only segments that meet the display threshold in the morning, midday and evening periods, `Σ length ÷ Σ (length ÷ segment speed in the period)`. Every segment has the same weight in every period.
- **Fixed coverage:** The qualifying length divided by the route's total segment length.
- **Fallback:** When coverage is under 50%, the route uses pooled speeds for the periods instead.
- **Peak speed:** The same calculation with the two peaks pooled within each segment.
- **Peak change:** `peak speed ÷ midday speed − 1`.

The network's own peak, midday and evening figures on the Overview are pooled across all routes, without fixed weighting. They answer a different question: how fast the service actually operating then was moving.

### Confidence intervals

- **Method:** Days are resampled with replacement 1,000 times, using each route's pooled daily distance and time. The interval is the 2.5th to 97.5th percentile. The random seed is fixed, so results are stable between visits.
- **Shown for:** Route peak speed and peak change, with at least five selected days.
- **Known limits:** It shows how much the result would move with a different set of similar days. It doesn't capture error in individual GPS reports. Resampling every segment for every route would be too slow, so the interval's width comes from pooled speeds, and it is then moved to surround the fixed-segment figure shown beside it.

### Share of time stopped

- **Formula:** Time in intervals moving under 0.9 m/s (about 2 mph) ÷ measured time.
- **Known limit:** At 20 s polling, a brief stop inside a longer interval averages away. Treat this as a floor.

### Slowest stretch

- **Definition:** The slowest window of about half a mile (800 m) on each direction's main pattern at peak, keeping the lower of the two directions.
- **Rules:** The window must span at least 600 m and have at least three times the display threshold in measurements. It keeps 1,609 m from each end of the line, or 10% of the length when the line is under about three miles. Named by the stops nearest its ends.

The **main pattern** is the one with the most complete observed trips in the selection, falling back to scheduled trip count and then length.

## Schedule adherence

### Stop passes

- **Departure:** The time progress crosses a point just past the stop. For the last stop, an arrival: the time it crosses a point just before.
- **Interpolation:** Linear between the reports either side.
- **Not recorded when:** The trip started past the stop, never reached it, or the bracketing reports are over 300 s apart.
- **The offset:** The crossing point is the stop-zone radius past the stop, up to 25 m. At normal speeds this adds about three seconds, well under any on-time threshold.

### On-time performance

- **Formula:** `on-time passes ÷ all timed passes`, where each pass's deviation is `observed − scheduled`.
- **Default window:** At least 1 minute early and less than 5 minutes late. Exactly one minute early is on time and exactly five minutes late is late. The calculation accepts any edges from the deviation bins: −5, −3, −1, 0, 1, 2, 3, 5, 10, 15 and 20 minutes.
- **Where measured:** At stops the schedule marks `timepoint = 1`. When a trip marks none, at all its stops.
- **Weighting:** Each trip counts once at each timepoint. Repeated polling doesn't change the weighting, unlike snapshot-based methods.
- **Data needed:** Trip IDs that match the schedule version in force, and a schedule that reflects what was operated.
- **Known limits:** It says nothing about a trip absent from the feed. A trip on detour can be missing passes, because reports off the line are skipped. Trips defined only through `frequencies.txt` aren't expanded, so their deviations aren't meaningful.

**Compared with common practice:** Many agencies use a one-minute-early, five-minute-late window at timepoints, but they read it from AVL stop events. Some exclude the final timepoint or measure only origin departures. This app includes every timepoint, using the arrival at the last stop.

### Stop-zone time

- **Definition:** The time between entering and leaving a zone around a stop. The zone extends 25 m each way, or half the distance to a neighboring stop if shorter.
- **What it approximates:** Dwell plus queuing to reach the stop, plus the few seconds needed to cross the zone at speed.
- **Left out:** The first and last stops of a trip, where vehicles wait by design, and any single pass over 10 minutes, which is a hold rather than boarding or queuing. Scheduled holds shorter than that at timepoints stay in.
- **Known limits:** It can't separate dwell from a signal or a queue at the same spot, and one pass at 20 s polling is coarse. Compare stops using averages over many passes. The zone isn't centered on the true boarding point when the stop's coordinates are offset.

## Frequent-service reliability

These measures apply only where the schedule runs every 15 minutes or better at a stop, on one route and direction. At lower frequencies riders time their arrival, so schedule adherence is the meaningful measure instead. Results with fewer than 10 headways aren't shown.

An **observed headway** is the time between consecutive vehicles passing a stop, assigned to the hour of the second vehicle. It is compared with the **scheduled headway at that point**: the gap between that trip's scheduled time and the previous one in the full schedule for the day. Comparing with the two observed trips' own spacing would hide a missing trip, which is exactly the wait riders notice.

Three things aren't counted as headways:

- **The same vehicle coming back.** On a loop, that's a cycle or a layover.
- **Arrivals at the last stop**, in both the observed and the scheduled figures. On a loop the last stop is also the first, and the gap between one trip arriving and the next leaving is a layover. Left in, a 30-minute service reads as a 4-minute one.
- **A gap longer than both an hour and four scheduled headways.** It usually means several passes went unobserved or the feed lost the route for a while, and because average wait grows with the square of a gap, one such value would dominate the result. This does remove the longest waits a rider could actually have seen, so read gap shares as a floor.

A trip that passes a stop twice doesn't set its own scheduled headway.

| Measure | Formula |
| --- | --- |
| Bunched | Observed headway under 25% of scheduled |
| Gap | Observed headway over 150% of scheduled |
| Wait assessment | Observed headway at most 3 minutes over scheduled |
| Average wait | `Σh² ÷ 2Σh`, the expected wait for a rider arriving at random |
| Scheduled wait | The same formula over the schedule's consecutive stop times, for gaps of 15 minutes or less |
| Excess wait | Average wait minus scheduled wait |

**Known limits:** A trip absent from the feed lengthens observed headways whether or not it ran. Read these beside trips observed, and treat them with caution when that share is low. A stop pass missed through a reporting gap has the same effect on a smaller scale. Excess wait assumes riders arrive at random and doesn't weight by ridership.

**Compared with common practice:** Excess wait follows the approach Transport for London popularized for high-frequency routes, here across every stop rather than sampled timing points. Wait assessment follows the New York style of measure, using a three-minute allowance at all hours; some agencies allow more off-peak. Definitions of bunching vary, and some use a fixed threshold in minutes rather than a share of the headway.

## Run times

- **Observed run time:** Time from the first stop passed to the last, on complete trips.
- **Complete:** Observed moving over at least 90% of the pattern's length, with at least two stop passes.
- **Scheduled run time:** The scheduled time between those same stops.
- **Reported:** The 10th, 50th and 90th percentiles of observed run time and the median scheduled time, on the main pattern in each direction, grouped by the hour the trip was scheduled to start.
- **Known limit:** Percentiles are exact over the selected trips, but a small selection gives few trips per hour. Each hour's result carries its trip count.

## Delay hotspots

- **Reference speed:** For each street cell, pooled across routes in one direction, the 85th percentile of its hourly speeds. It needs at least three hours that meet the display threshold.
- **Delay:** `Σ over hours of max(0, time spent − distance ÷ reference speed)`, in vehicle hours per day.
- **Building stretches:** Starting from the cell with the most delay per meter, a stretch extends along the most-traveled next and previous cells while each still has at least 35% of the starting cell's delay per meter, until it reaches about 1,500 m. The most-traveled neighbor comes from every pattern, weighted by scheduled trips. Used cells can't join another stretch.
- **Ranking:** By total delay per day. The top 40 are listed, named by the stops nearest each end.
- **Known limits:** Each cell is compared with itself. A block slow at every hour shows little delay, so check the speed map for those. The measure also includes dwell at busy stops, so a high value doesn't by itself mean traffic. Vehicle hours are not passenger hours, so ranking by rider delay would need ridership.

**Compared with common practice:** Congestion analyses often use an overnight or posted-speed reference. A cell's own 85th percentile hour is more conservative, and it is available for any segment with enough service in at least three hours.

## Stops

### Stop spacing

- **Definition:** Distance along the line between consecutive stops on the main pattern in each direction.
- **Reported:** Mean, median, stops per kilometer, and the share of gaps under 244 m (about 800 ft).
- **Nearest stop:** For a single stop, the shortest gap to a neighbor among the main patterns serving it.
- **Known limit:** This describes stops as scheduled. It doesn't weigh ridership, access, grade or safety, so it's where a stop balancing review starts rather than ends.

### Stop-level results

Passes per day, average stop-zone time, daily stop-zone hours, mean deviation and on-time share are pooled across every route at a stop. On-time share here uses all passes, not only timepoints, so it can differ from the route figures. Most stop times between timepoints are interpolated by the agency, so read deviations at those stops as a guide rather than a commitment.

## Service levels

### Trips observed

- **Definition:** Runs that moved over at least half of the pattern's length, by the hour they were scheduled to start.
- **Compared with:** Trips active that date under `calendar` and `calendar_dates`.
- **Known limits:** A share below 100% may mean cancellations, missing trip IDs or feed gaps. A trip counts once, even when a vehicle change splits it into two runs.

### Vehicles in service

- **Definition:** Distinct vehicle IDs with a measured interval in the hour.
- **Network total:** Counts each vehicle once per hour across routes. Under a mode filter it can't, so interlined vehicles can count twice.
- **Known limit:** Vehicles without a trip ID aren't counted, so this reflects vehicles assigned to trips, not the whole fleet out.

### Service hours

- **Scheduled:** First scheduled departure to last scheduled arrival, split across hours.
- **Observed:** A run's first report to its last, split across hours. This can include some terminal layover, so it runs higher than the time used for speed.

### Occupancy

Counts of position reports at each GTFS-RT `occupancy_status` value, per route and hour, where the feed reports them. Reports are not trips or riders, and what each status means varies by agency.

## Data quality

| Count | Meaning |
| --- | --- |
| Archive rows | Rows fetched from 3 AM on the service date to 3 AM the next day, on an ordinary day |
| No trip assigned | Rows with no trip ID: out-of-service moves and layovers |
| No vehicle ID, unusable coordinates | Rows that can't be placed. Coordinates must be in range and not exactly (0, 0) |
| Repeated polls and rows on other days' trips | Rows left after the steps above and the distinct reports used. Approximate, because rows are counted by hour and reports by service day |
| Distinct reports | One per descriptor, vehicle and report time, on runs assigned to this service date |
| Trip ID missing from the schedule | Reports whose trip isn't in the schedule, across all the data read when the day was processed. Neighboring days overlap, so this isn't totalled |
| Capture gaps | Five-minute periods within the day's scheduled service with no feed capture at all |

A frozen GPS unit repeats one report time across polls, so only the first is kept. When a report has no timestamp, its fetch time stands in, and those are counted.

A feed that reports differential updates gets a warning, because the archive doesn't keep every deletion and vehicle state can be incomplete. When fewer than one in ten trip-bearing reports match the schedule, the feed and schedule don't belong together, and the day falls back to GPS speeds. Between one in ten and four in five, the app keeps the schedule join and notes that some trips were left out, which is normal for a feed shared with other agencies.

## Known limits

These came out of independent validation against raw data, and each is small enough on the agencies tested to leave as it is. See [validation](validation.md) for the measurements.

- **Terminal repositioning can read as a departure.** The first-stop departure is the first time a vehicle crosses the stop, so a bus creeping forward during layover can read as leaving early. Treat single first-stop events with care.
- **A vehicle reporting its trip long before starting can lock on mid-line.** Only the first fix on the line seeds the match, so its first position decides which pass it starts from.
- **One trip ID run by two vehicles counts twice in on-time performance.** This is rare: 26 events on 3 trips in a day of King County Metro service.
- **Buses that leave the shape stay noisy.** Where vehicles regularly run a different path from the published shape, stop events and some hourly speeds on that route are unreliable. The route's off-route count in Data & methods is the signal.
- **Corners are measured at the vertex.** A vehicle rounds a corner rather than turning on the centerline, so true distance is slightly shorter. On Madison this bounds the network figure between about 15.17 and 15.23 mph.

### GPS-only speeds

When a day can't be joined to a schedule, speed comes from straight lines between consecutive reports. Compared with schedule-joined speeds on the same reports, that read 10.2% low in Madison and 5.2% low in King County, and 22% to 26% low on the worst single routes. A few routes read high, up to 9%, so no single correction factor works. Ranking between routes holds up well (rank correlation 0.96 and 0.99). Use these speeds to compare routes and times of day, not as absolute figures.

## Not calculated

These would need data the archive doesn't have, or a method not yet validated:

- Ridership, passenger delay, passenger-weighted anything, and cost per rider
- Cancelled or missed trips as a confirmed count
- Door-open dwell, signal delay or transit priority effects
- Reliability on frequency-based schedules defined through `frequencies.txt`
- Comparisons between agencies as a single score, since feeds differ in polling rate, coverage and how they mark timepoints

Speed classes on the map are absolute so colors mean the same thing across agencies: under 5, 5 to 8, 8 to 10, 10 to 13, 13 to 16, 16 to 20, and over 20 mph. Rail and ferry use 10, 15, 20, 28, 36 and 45 mph as breaks. The map's "under 8 mph" share counts segments rather than distance, and isn't a network-wide measure of delay.
