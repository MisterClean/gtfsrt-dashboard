//! Turns one service day's fixes and schedule into rollups.

use crate::cube::{
    self, DayCube, Headways, METRIC_VERSION, Quality, RouteHour, RouteVehicles, SegHour, StopEvent,
    StopPeriod, TripRow,
};
use crate::rt::{Descriptor, Fix, NO_START_DATE, RtBuffer};
use crate::schedule::{Pattern, Schedule, Trip};
use crate::time::{Clock, SERVICE_HOURS, ServiceDate, service_hour};
use crate::trace::{
    Interval, IntervalCounts, TracePoint, TraceRules, crossing_time, intervals, match_fixes,
};
use rustc_hash::{FxHashMap, FxHashSet};

/// Half-width of the zone around a stop. Time between its edges approximates
/// dwell plus queuing; with 20 s polling that only means anything in aggregate.
const STOP_ZONE_M: f32 = 25.0;
/// How far stop times may be interpolated across a reporting gap.
const MAX_EVENT_GAP_S: f32 = 300.0;
/// A new run of the same trip and vehicle starts after a silence this long,
/// which separates the same trip ID on consecutive days.
const RUN_BREAK_S: u32 = 3 * 3600;
/// A run must move at least this share of the line to count as observed.
const OBSERVED_COVERAGE: f32 = 0.5;

/// The output of [`process_day`].
pub struct DayResult {
    pub cube: DayCube,
    pub events: Vec<StopEvent>,
}

/// One observed stop pass, before headways are computed.
#[derive(Clone, Copy)]
struct Pass {
    route: u32,
    dir: u8,
    stop: u32,
    time: f64,
    scheduled: i32,
}

#[derive(Default)]
struct Accumulator {
    route_hours: FxHashMap<(u32, u8, u8), RouteHour>,
    seg_hours: FxHashMap<(u32, u8), SegHour>,
    stop_periods: FxHashMap<(u32, u8, u32, u8), StopPeriod>,
    vehicles_seen: FxHashSet<(u32, u8, u32)>,
    /// A trip counts once, even when a vehicle swap splits it into two runs.
    trips_seen: FxHashSet<u32>,
    trips_seen_complete: FxHashSet<u32>,
}

impl Accumulator {
    fn route_hour(&mut self, route: u32, dir: u8, hour: usize) -> &mut RouteHour {
        self.route_hours
            .entry((route, dir, hour as u8))
            .or_insert_with(|| RouteHour {
                route,
                dir,
                hour: hour as u8,
                ..RouteHour::default()
            })
    }

    fn stop_period(&mut self, route: u32, dir: u8, stop: u32, hour: usize) -> &mut StopPeriod {
        let period = cube::stop_period(hour) as u8;
        self.stop_periods
            .entry((route, dir, stop, period))
            .or_insert_with(|| StopPeriod {
                route,
                dir,
                stop,
                period,
                ..StopPeriod::default()
            })
    }
}

/// Builds the rollups for `date` from whatever fixes are in the buffer.
///
/// `complete_through` is the epoch up to which archive files have been read. A
/// day with service past that point is flagged as partial.
pub fn process_day(
    schedule: &Schedule,
    buffer: &mut RtBuffer,
    date: ServiceDate,
    clock: &Clock,
    complete_through: i64,
) -> Result<DayResult, String> {
    let origin = clock
        .service_origin(date)
        .ok_or_else(|| format!("{date} is outside the supported calendar."))?;

    let mut acc = Accumulator::default();
    let mut quality = Quality::default();
    let mut warnings = schedule.warnings.clone();

    let scheduled_at_stops = add_schedule_totals(schedule, date, &mut acc, &mut quality);
    add_input_counts(buffer, origin, &mut quality);

    let trip_of: Vec<Option<u32>> = (0..buffer.trips.len() as u32)
        .map(|id| schedule.trip_lookup.get(buffer.trips.get(id)).copied())
        .collect();

    sort_and_dedup(&mut buffer.fixes);
    // The buffer also holds neighbouring days. Count only the hours this day owns,
    // the same ones `add_input_counts` assigns to it.
    let owned_start = origin + 3 * 3600;
    let owned = move |fix: &Fix| {
        let time = i64::from(fix.time);
        time >= owned_start && time < owned_start + 86_400
    };
    quality.fixes_unique = buffer.fixes.iter().filter(|fix| owned(fix)).count() as u64;

    let mut trips: Vec<TripRow> = Vec::new();
    let mut events: Vec<StopEvent> = Vec::new();
    let mut passes: Vec<Pass> = Vec::new();

    for run in runs(&buffer.fixes) {
        let descriptor = buffer.descriptors[run[0].descriptor as usize];
        let Some(trip_index) = trip_of[descriptor.trip as usize] else {
            quality.fixes_trip_unmatched += run.iter().filter(|fix| owned(fix)).count() as u64;
            continue;
        };
        let trip = &schedule.trips[trip_index as usize];
        if run_service_date(schedule, trip, descriptor, run, clock) != Some(date) {
            continue;
        }
        quality.fixes_on_day += run.len() as u64;
        process_run(
            schedule,
            trip_index,
            trip,
            run,
            buffer,
            origin,
            &mut acc,
            &mut quality,
            &mut trips,
            &mut events,
            &mut passes,
        );
    }

    add_headways(&mut passes, &scheduled_at_stops, &mut acc);

    let (route_vehicles, network_vehicles) = count_vehicles(&acc.vehicles_seen);

    quality.trips_observed = acc.trips_seen.len() as u32;
    quality.trips_complete = acc.trips_seen_complete.len() as u32;

    add_poll_coverage(buffer, schedule, date, origin, &mut quality);

    if quality.differential > 0 {
        warnings.push(
            "This feed reports differential updates. The archive does not keep every deletion, so vehicle state can be incomplete."
                .to_owned(),
        );
    }
    if let Some(last) = last_scheduled_time(schedule, date)
        && origin + i64::from(last) > complete_through
    {
        warnings.push(
            "The archive file covering the end of this service day is not published yet, so evening trips are missing."
                .to_owned(),
        );
    }

    let mut route_hours: Vec<RouteHour> = acc.route_hours.into_values().collect();
    route_hours.sort_by_key(|r| (r.route, r.dir, r.hour));
    let mut seg_hours: Vec<SegHour> = acc.seg_hours.into_values().collect();
    seg_hours.sort_by_key(|s| (s.seg, s.hour));
    let mut stop_periods: Vec<StopPeriod> = acc.stop_periods.into_values().collect();
    stop_periods.sort_by_key(|s| (s.route, s.dir, s.stop, s.period));

    Ok(DayResult {
        cube: DayCube {
            date: date.0,
            digest: schedule.digest.clone(),
            metric_version: METRIC_VERSION,
            route_hours,
            seg_hours,
            stop_periods,
            trips,
            route_vehicles,
            network_vehicles,
            quality,
            warnings,
        },
        events,
    })
}

/// Distinct vehicles per route and hour, and across the network per hour.
fn count_vehicles(seen: &FxHashSet<(u32, u8, u32)>) -> (Vec<RouteVehicles>, Vec<u32>) {
    let mut by_route: FxHashMap<(u32, u8), u32> = FxHashMap::default();
    let mut network: FxHashSet<(u8, u32)> = FxHashSet::default();
    for (route, hour, vehicle) in seen {
        *by_route.entry((*route, *hour)).or_default() += 1;
        network.insert((*hour, *vehicle));
    }
    let mut route_vehicles: Vec<RouteVehicles> = by_route
        .into_iter()
        .map(|((route, hour), vehicles)| RouteVehicles {
            route,
            hour,
            vehicles,
        })
        .collect();
    route_vehicles.sort_by_key(|r| (r.route, r.hour));
    let mut network_vehicles = vec![0_u32; SERVICE_HOURS];
    for (hour, _) in network {
        network_vehicles[hour as usize] += 1;
    }
    (route_vehicles, network_vehicles)
}

fn sort_and_dedup(fixes: &mut Vec<Fix>) {
    fixes.sort_unstable_by_key(|f| (f.descriptor, f.vehicle, f.time));
    // A frozen unit repeats one timestamp across polls: keep the first report.
    fixes.dedup_by_key(|f| (f.descriptor, f.vehicle, f.time));
}

/// Splits fixes sorted by descriptor, vehicle and time into continuous runs.
fn runs(fixes: &[Fix]) -> impl Iterator<Item = &[Fix]> {
    fixes.chunk_by(|a, b| {
        a.descriptor == b.descriptor
            && a.vehicle == b.vehicle
            && b.time.saturating_sub(a.time) <= RUN_BREAK_S
    })
}

/// Which service date a run belongs to. The feed's own start date wins. Without
/// one, it is the active service date whose scheduled window best contains the
/// run, which is how the many feeds that leave `start_date` blank are handled.
fn run_service_date(
    schedule: &Schedule,
    trip: &Trip,
    descriptor: Descriptor,
    run: &[Fix],
    clock: &Clock,
) -> Option<ServiceDate> {
    if descriptor.start_date != NO_START_DATE {
        return Some(ServiceDate(descriptor.start_date));
    }
    let (arrivals, departures) = schedule.trip_times(trip);
    let (first, last) = (*departures.first()?, *arrivals.last()?);
    let middle = i64::from(run[run.len() / 2].time);
    let today = clock.local_date(middle)?;
    let mut best: Option<(i64, ServiceDate)> = None;
    for offset in [-1_i64, 0, 1] {
        let Some(candidate) = today.offset(offset) else {
            continue;
        };
        if !schedule.service_active(trip, candidate) {
            continue;
        }
        let Some(origin) = clock.service_origin(candidate) else {
            continue;
        };
        let start = origin + i64::from(first);
        let end = origin + i64::from(last);
        let distance = if middle < start {
            start - middle
        } else if middle > end {
            middle - end
        } else {
            0
        };
        if best.is_none_or(|(d, _)| distance < d) {
            best = Some((distance, candidate));
        }
    }
    // A run hours away from any scheduled window isn't this trip's service.
    best.filter(|(distance, _)| *distance <= 4 * 3600)
        .map(|(_, date)| date)
}

/// Scheduled stop times per route, direction and stop, sorted.
type ScheduledAtStops = FxHashMap<(u32, u8, u32), Vec<i32>>;

fn add_schedule_totals(
    schedule: &Schedule,
    date: ServiceDate,
    acc: &mut Accumulator,
    quality: &mut Quality,
) -> ScheduledAtStops {
    let mut by_stop: ScheduledAtStops = FxHashMap::default();
    for trip in &schedule.trips {
        if !schedule.service_active(trip, date) {
            continue;
        }
        quality.trips_scheduled += 1;
        let pattern = &schedule.patterns[trip.pattern as usize];
        let (arrivals, departures) = schedule.trip_times(trip);
        let (Some(&start), Some(&end)) = (departures.first(), arrivals.last()) else {
            continue;
        };
        acc.route_hour(trip.route, pattern.dir, service_hour(i64::from(start)))
            .trips_scheduled += 1;
        add_time_by_hour(start, end, |hour, seconds| {
            acc.route_hour(trip.route, pattern.dir, hour)
                .service_seconds_scheduled += seconds;
        });
        for i in 0..pattern.stops.len() {
            let time = departures[i];
            let hour = service_hour(i64::from(time));
            acc.stop_period(trip.route, pattern.dir, pattern.stops[i], hour)
                .scheduled += 1;
            by_stop
                .entry((trip.route, pattern.dir, pattern.stops[i]))
                .or_default()
                .push(time);
            if i + 1 < pattern.stops.len() {
                let seconds = (arrivals[i + 1] - departures[i]).max(0);
                let meters = pattern.stop_s[i + 1] - pattern.stop_s[i];
                let middle = i64::from(departures[i]) + i64::from(seconds) / 2;
                let row = acc.route_hour(trip.route, pattern.dir, service_hour(middle));
                row.sched_seconds += f64::from(seconds);
                row.sched_meters += f64::from(meters);
            }
        }
    }
    for ((route, dir, _), times) in &mut by_stop {
        times.sort_unstable();
        for pair in times.windows(2) {
            let headway = f64::from(pair[1] - pair[0]);
            if headway <= 0.0 || headway > cube::FREQUENT_HEADWAY_S {
                continue;
            }
            let row = acc.route_hour(*route, *dir, service_hour(i64::from(pair[1])));
            row.sched_headway_count += 1;
            row.sched_headway_sum += headway;
            row.sched_headway_squares += headway * headway;
        }
    }
    by_stop
}

/// Splits a span of seconds-from-origin across the hours it covers.
fn add_time_by_hour(start: i32, end: i32, mut add: impl FnMut(usize, f64)) {
    let mut current = start;
    while current < end {
        let hour = service_hour(i64::from(current));
        let boundary = ((hour as i32 + 1) * 3600).max(current + 1);
        let next = if hour + 1 == SERVICE_HOURS {
            end
        } else {
            boundary.min(end)
        };
        add(hour, f64::from(next - current));
        current = next;
    }
}

fn add_input_counts(buffer: &RtBuffer, origin: i64, quality: &mut Quality) {
    // The hours from 03:00 on the service date to 03:00 the next day belong to
    // it, so every hour of raw rows is counted against exactly one day.
    let start = (origin + 3 * 3600) / 3600;
    let end = start + 24;
    for (hour, counts) in &buffer.hours {
        if (start..end).contains(&i64::from(*hour)) {
            quality.rows += u64::from(counts.rows);
            quality.no_trip += u64::from(counts.no_trip);
            quality.no_vehicle += u64::from(counts.no_vehicle);
            quality.bad_coordinate += u64::from(counts.bad_coordinate);
            quality.fallback_time += u64::from(counts.fallback_time);
            quality.differential += u64::from(counts.differential);
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn process_run(
    schedule: &Schedule,
    trip_index: u32,
    trip: &Trip,
    run: &[Fix],
    buffer: &RtBuffer,
    origin: i64,
    acc: &mut Accumulator,
    quality: &mut Quality,
    trips: &mut Vec<TripRow>,
    events: &mut Vec<StopEvent>,
    passes: &mut Vec<Pass>,
) {
    let pattern = &schedule.patterns[trip.pattern as usize];
    let line = &schedule.polylines[schedule.pattern_line[trip.pattern as usize] as usize];
    let route_type = schedule.routes[trip.route as usize].route_type;
    let rules = TraceRules::for_route_type(route_type);
    let (arrivals, departures) = schedule.trip_times(trip);

    let fixes: Vec<(i64, f32, f32)> = run
        .iter()
        .map(|f| (i64::from(f.time), f.lat, f.lon))
        .collect();
    let expected = |t: i64| expected_position(pattern, departures, t - origin);
    let trace = match_fixes(line, &fixes, &rules, expected);
    quality.off_route += u64::from(trace.off_route);
    quality.backward += u64::from(trace.backward);

    let mut counts = IntervalCounts::default();
    let kept = intervals(&trace, &rules, &mut counts);
    add_counts(quality, &counts);

    let vehicle = run[0].vehicle;
    for interval in &kept {
        add_interval(
            pattern,
            trip.route,
            interval,
            origin,
            rules.stopped_mps,
            acc,
            quality,
        );
        let hour = service_hour((interval.t0 + interval.t1) / 2 - origin);
        acc.vehicles_seen.insert((trip.route, hour as u8, vehicle));
    }
    add_occupancy(run, pattern, trip.route, origin, acc);

    let Some((first, last)) = trace.points.first().zip(trace.points.last()) else {
        return;
    };
    let coverage = if pattern.length_m > 0.0 {
        (last.s - first.s) / pattern.length_m
    } else {
        0.0
    };

    let trip_row_index = trips.len() as u32;
    let stop_row = stop_passes(
        &trace.points,
        schedule,
        trip,
        pattern,
        origin,
        trip_row_index,
        acc,
        quality,
        events,
        passes,
    );

    let (Some(&sched_start), Some(&sched_end)) = (departures.first(), arrivals.last()) else {
        return;
    };
    let first_observed = (first.t - origin) as i32;
    let last_observed = (last.t - origin) as i32;
    if coverage >= OBSERVED_COVERAGE && acc.trips_seen.insert(trip_index) {
        acc.route_hour(
            trip.route,
            pattern.dir,
            service_hour(i64::from(sched_start)),
        )
        .trips_observed += 1;
    }
    add_time_by_hour(first_observed, last_observed, |hour, seconds| {
        acc.route_hour(trip.route, pattern.dir, hour)
            .service_seconds_observed += seconds;
    });

    let row = TripRow {
        pattern: trip.pattern,
        route: trip.route,
        dir: pattern.dir,
        trip_id: trip.id.clone(),
        vehicle: buffer.vehicles.get(vehicle).to_owned(),
        sched_start,
        sched_end,
        first_observed,
        last_observed,
        coverage,
        observed_run: stop_row.observed_run,
        scheduled_run: stop_row.scheduled_run,
        first_stop: stop_row.first_stop,
        last_stop: stop_row.last_stop,
        end_deviation: stop_row.end_deviation,
        fixes: trace.points.len() as u32,
        off_route: trace.off_route,
    };
    if row.complete() {
        acc.trips_seen_complete.insert(trip_index);
    }
    trips.push(row);
}

/// Where the schedule says the trip should be, as a tie-breaker for the first fix.
fn expected_position(
    pattern: &Pattern,
    departures: &[i32],
    seconds_from_origin: i64,
) -> Option<f32> {
    let t = i32::try_from(seconds_from_origin).ok()?;
    let index = departures.partition_point(|d| *d <= t);
    if index == 0 {
        return pattern.stop_s.first().copied();
    }
    if index >= departures.len() {
        return pattern.stop_s.last().copied();
    }
    let (t0, t1) = (departures[index - 1], departures[index]);
    let (s0, s1) = (pattern.stop_s[index - 1], pattern.stop_s[index]);
    let fraction = if t1 > t0 {
        (t - t0) as f32 / (t1 - t0) as f32
    } else {
        0.0
    };
    Some(s0 + (s1 - s0) * fraction)
}

fn add_counts(quality: &mut Quality, counts: &IntervalCounts) {
    quality.pairs += u64::from(counts.pairs);
    quality.pairs_layover += u64::from(counts.layover);
    quality.pairs_long_gap += u64::from(counts.long_gap);
    quality.pairs_geometry += u64::from(counts.geometry);
    quality.pairs_too_fast += u64::from(counts.too_fast);
    quality.pairs_standstill += u64::from(counts.standstill);
    quality.pairs_kept += u64::from(counts.kept);
    quality.seconds_layover += f64::from(counts.layover_s);
    quality.seconds_standstill += f64::from(counts.standstill_s);
}

/// Allocates one interval's distance and time to the segments it crossed,
/// assuming constant speed within it. A vehicle standing still puts all its time
/// in one segment, which is where the delay actually happened.
fn add_interval(
    pattern: &Pattern,
    route: u32,
    interval: &Interval,
    origin: i64,
    stopped_mps: f32,
    acc: &mut Accumulator,
    quality: &mut Quality,
) {
    let seconds = interval.seconds();
    let meters = interval.meters();
    if seconds <= 0.0 {
        return;
    }
    // [T8] Each interval is assigned to the hour of its midpoint.
    let hour = service_hour((interval.t0 + interval.t1) / 2 - origin);
    let stopped = meters / seconds < stopped_mps;
    let row = acc.route_hour(route, pattern.dir, hour);
    row.meters += f64::from(meters);
    row.seconds += f64::from(seconds);
    if stopped {
        row.stopped_seconds += f64::from(seconds);
    }
    quality.meters_kept += f64::from(meters);
    quality.seconds_kept += f64::from(seconds);

    let bins = &pattern.bins;
    if bins.is_empty() {
        return;
    }
    let start = bins
        .partition_point(|b| b.s1 <= interval.s0)
        .min(bins.len() - 1);
    let mut index = start;
    loop {
        let bin = bins[index];
        let overlap = (interval.s1.min(bin.s1) - interval.s0.max(bin.s0)).max(0.0);
        let share = if meters > 0.0 {
            overlap / meters
        } else if index == start {
            1.0
        } else {
            0.0
        };
        if share > 0.0 {
            let cell = acc
                .seg_hours
                .entry((bin.seg, hour as u8))
                .or_insert_with(|| SegHour {
                    seg: bin.seg,
                    hour: hour as u8,
                    ..SegHour::default()
                });
            cell.meters += overlap;
            cell.seconds += seconds * share;
            if stopped {
                cell.stopped_seconds += seconds * share;
            }
            cell.pairs += 1;
        }
        index += 1;
        if index >= bins.len() || bins[index].s0 >= interval.s1 {
            break;
        }
    }
}

fn add_occupancy(run: &[Fix], pattern: &Pattern, route: u32, origin: i64, acc: &mut Accumulator) {
    for fix in run {
        if (0..9).contains(&fix.occupancy) {
            let hour = service_hour(i64::from(fix.time) - origin);
            acc.route_hour(route, pattern.dir, hour).occupancy[fix.occupancy as usize] += 1;
        }
    }
}

#[derive(Default)]
struct StopSummary {
    observed_run: i32,
    scheduled_run: i32,
    first_stop: u16,
    last_stop: u16,
    end_deviation: Option<i32>,
}

/// Finds when the trip passed each stop and records schedule deviation.
#[allow(clippy::too_many_arguments)]
fn stop_passes(
    points: &[TracePoint],
    schedule: &Schedule,
    trip: &Trip,
    pattern: &Pattern,
    origin: i64,
    trip_row: u32,
    acc: &mut Accumulator,
    quality: &mut Quality,
    events: &mut Vec<StopEvent>,
    passes: &mut Vec<Pass>,
) -> StopSummary {
    let (arrivals, departures) = schedule.trip_times(trip);
    let timepoints = schedule.trip_timepoints(trip);
    let count = pattern.stops.len();
    let mut summary = StopSummary::default();
    let mut first_seen: Option<(usize, f64)> = None;
    let mut last_seen: Option<(usize, f64)> = None;
    quality.stops_expected += count as u64;

    for i in 0..count {
        let stop_s = pattern.stop_s[i];
        let is_last = i + 1 == count;
        // The zone shrinks where stops are close, so zones never overlap.
        let gap_before = if i > 0 {
            stop_s - pattern.stop_s[i - 1]
        } else {
            f32::MAX
        };
        let gap_after = if is_last {
            f32::MAX
        } else {
            pattern.stop_s[i + 1] - stop_s
        };
        let radius = STOP_ZONE_M
            .min(gap_before / 2.0)
            .min(gap_after / 2.0)
            .max(1.0);
        let enter = crossing_time(points, stop_s - radius, MAX_EVENT_GAP_S);
        let leave = crossing_time(points, stop_s + radius, MAX_EVENT_GAP_S);

        // Schedule adherence reads the departure, except at the last stop where
        // a vehicle arrives and goes no further.
        let (observed, scheduled) = if is_last {
            (enter, arrivals[i])
        } else {
            (leave, departures[i])
        };
        let Some(observed) = observed else {
            continue;
        };
        quality.stops_observed += 1;
        let seconds_from_origin = observed - origin as f64;
        let deviation = (seconds_from_origin - f64::from(scheduled)).round() as i32;
        let hour = service_hour(seconds_from_origin as i64);
        let stop = pattern.stops[i];

        // On-time performance is measured at timepoints when the agency marks
        // them, since other stop times are usually interpolated.
        let counts_for_otp = if trip.has_timepoints {
            timepoints[i]
        } else {
            true
        };
        {
            let period = acc.stop_period(trip.route, pattern.dir, stop, hour);
            period.passes += 1;
            period.deviation[cube::deviation_bin(deviation)] += 1;
            period.deviation_sum += f64::from(deviation);
            if let (Some(a), Some(b)) = (enter, leave)
                && b >= a
            {
                period.zone_seconds += (b - a) as f32;
                period.zone_count += 1;
            }
        }
        if counts_for_otp {
            let row = acc.route_hour(trip.route, pattern.dir, hour);
            row.deviation[cube::deviation_bin(deviation)] += 1;
            row.deviation_sum += f64::from(deviation);
        }
        events.push(StopEvent {
            trip: trip_row,
            stop_index: i as u16,
            observed: seconds_from_origin.round() as i32,
            scheduled,
        });
        passes.push(Pass {
            route: trip.route,
            dir: pattern.dir,
            stop,
            time: seconds_from_origin,
            scheduled,
        });
        if first_seen.is_none() {
            first_seen = Some((i, observed));
        }
        last_seen = Some((i, observed));
        if is_last {
            summary.end_deviation = Some(deviation);
        }
    }

    if let (Some((first, t0)), Some((last, t1))) = (first_seen, last_seen)
        && last > first
    {
        summary.first_stop = first as u16;
        summary.last_stop = last as u16;
        summary.observed_run = (t1 - t0).round() as i32;
        let scheduled_end = if last + 1 == count {
            arrivals[last]
        } else {
            departures[last]
        };
        summary.scheduled_run = scheduled_end - departures[first];
    }
    summary
}

/// Observed headways: the time between consecutive vehicles at each stop.
///
/// Each is compared with the headway the full schedule promised at that point.
/// Comparing against the two observed trips' own spacing would hide a missing
/// trip, which is exactly the wait riders notice.
fn add_headways(passes: &mut [Pass], scheduled_at_stops: &ScheduledAtStops, acc: &mut Accumulator) {
    passes.sort_unstable_by(|a, b| {
        (a.route, a.dir, a.stop)
            .cmp(&(b.route, b.dir, b.stop))
            .then(a.time.total_cmp(&b.time))
    });
    for group in passes.chunk_by(|a, b| (a.route, a.dir, a.stop) == (b.route, b.dir, b.stop)) {
        let Some(times) = scheduled_at_stops.get(&(group[0].route, group[0].dir, group[0].stop))
        else {
            continue;
        };
        for pair in group.windows(2) {
            let observed = pair[1].time - pair[0].time;
            if observed <= 0.0 {
                continue;
            }
            let Some(scheduled) = scheduled_gap(times, pair[1].scheduled) else {
                continue;
            };
            if scheduled > cube::FREQUENT_HEADWAY_S {
                continue;
            }
            let hour = service_hour(pair[1].time as i64);
            let mut record = Headways::default();
            record.record(observed, scheduled);
            let (route, dir, stop) = (pair[1].route, pair[1].dir, pair[1].stop);
            acc.route_hour(route, dir, hour).headways.add(&record);
            acc.stop_period(route, dir, stop, hour)
                .headways
                .add(&record);
        }
    }
}

/// The scheduled gap before `time` in a sorted list of scheduled stop times.
fn scheduled_gap(times: &[i32], time: i32) -> Option<f64> {
    let index = times.partition_point(|t| *t < time);
    let previous = *times.get(index.checked_sub(1)?)?;
    let gap = f64::from(time - previous);
    (gap > 0.0).then_some(gap)
}

/// Polls per hour and capture gaps during scheduled service.
fn add_poll_coverage(
    buffer: &mut RtBuffer,
    schedule: &Schedule,
    date: ServiceDate,
    origin: i64,
    quality: &mut Quality,
) {
    buffer.polls.sort_unstable();
    buffer.polls.dedup();
    for poll in &buffer.polls {
        let offset = i64::from(*poll) - origin;
        if (0..SERVICE_HOURS as i64 * 3600).contains(&offset) {
            quality.polls[service_hour(offset)] += 1;
        }
    }
    let Some((first, last)) = scheduled_span(schedule, date) else {
        return;
    };
    let bucket = 300_i64;
    let mut seen: FxHashSet<i64> = FxHashSet::default();
    for poll in &buffer.polls {
        let offset = i64::from(*poll) - origin;
        if offset >= i64::from(first) && offset <= i64::from(last) {
            seen.insert(offset.div_euclid(bucket));
        }
    }
    let first_bucket = i64::from(first).div_euclid(bucket);
    let last_bucket = i64::from(last).div_euclid(bucket);
    quality.service_buckets = (last_bucket - first_bucket + 1).max(0) as u32;
    quality.empty_buckets = quality.service_buckets.saturating_sub(seen.len() as u32);
}

fn scheduled_span(schedule: &Schedule, date: ServiceDate) -> Option<(i32, i32)> {
    let mut span: Option<(i32, i32)> = None;
    for trip in &schedule.trips {
        if !schedule.service_active(trip, date) {
            continue;
        }
        let (arrivals, departures) = schedule.trip_times(trip);
        if let (Some(&start), Some(&end)) = (departures.first(), arrivals.last()) {
            span = Some(span.map_or((start, end), |(a, b)| (a.min(start), b.max(end))));
        }
    }
    span
}

fn last_scheduled_time(schedule: &Schedule, date: ServiceDate) -> Option<i32> {
    scheduled_span(schedule, date).map(|(_, end)| end)
}

/// The earliest and latest epochs a service day's fixes can fall in. Reads of
/// archive files use this window so row groups outside it are skipped entirely.
pub fn day_window(clock: &Clock, date: ServiceDate) -> Option<(i64, i64)> {
    let origin = clock.service_origin(date)?;
    Some((origin, origin + SERVICE_HOURS as i64 * 3600))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rt::RawFix;
    use crate::schedule::fixtures::line_route;

    const DATE: ServiceDate = ServiceDate(20261105); // a Thursday

    fn clock() -> Clock {
        Clock::fixed(-6 * 3600)
    }

    /// A simulated vehicle following trip `index` with a constant delay.
    fn drive(
        buffer: &mut RtBuffer,
        trip: &str,
        vehicle: &str,
        start_seconds: i64,
        delay: i64,
        speed_scale: f64,
    ) {
        let origin = clock().service_origin(DATE).unwrap();
        // The line is 4.4 km with 5 stops, 300 s apart on the schedule.
        let total = (1200.0 * speed_scale) as i64;
        let mut t = -60;
        while t <= total + 120 {
            let progress = (t as f64 / total as f64).clamp(0.0, 1.0);
            let epoch = origin + start_seconds + delay + t;
            buffer.push(RawFix {
                fetch: epoch as f64 + 1.0,
                timestamp: epoch as f64,
                lat: (43.0 + 0.04 * progress) as f32,
                lon: -89.0,
                trip_id: Some(trip.as_bytes()),
                vehicle_id: Some(vehicle.as_bytes()),
                route_id: Some(b"R1"),
                start_date: None,
                start_time: None,
                occupancy: 1,
                differential: false,
            });
            t += 20;
        }
    }

    fn run_day(buffer: &mut RtBuffer) -> DayResult {
        let schedule = line_route();
        process_day(&schedule, buffer, DATE, &clock(), i64::MAX).unwrap()
    }

    #[test]
    fn a_trip_on_schedule_measures_the_scheduled_speed_and_is_on_time() {
        let mut buffer = RtBuffer::default();
        drive(&mut buffer, "T0", "V1", 7 * 3600, 0, 1.0);
        let result = run_day(&mut buffer);
        let quality = result.cube.quality;
        assert_eq!(quality.trips_scheduled, 12);
        assert_eq!(quality.trips_observed, 1);
        assert_eq!(quality.trips_complete, 1);

        let row = result
            .cube
            .route_hours
            .iter()
            .find(|r| r.hour == 7)
            .unwrap();
        // 4.45 km in 1200 s is 3.71 m/s. Layover trim removes the terminal wait.
        let speed = row.meters / row.seconds;
        assert!((speed - 3.71).abs() < 0.25, "speed {speed}");
        // Both timepoints fall in the on-time bins (-60 to +300 s).
        let on_time: u32 = row.deviation[3..=7].iter().sum();
        let total: u32 = row.deviation.iter().sum();
        assert_eq!(on_time, total, "{:?}", row.deviation);
        assert!(total >= 1);
    }

    #[test]
    fn a_late_trip_lands_in_the_late_deviation_bins() {
        let mut buffer = RtBuffer::default();
        drive(&mut buffer, "T0", "V1", 7 * 3600, 420, 1.0);
        let result = run_day(&mut buffer);
        let row = result
            .cube
            .route_hours
            .iter()
            .find(|r| r.deviation.iter().sum::<u32>() > 0)
            .unwrap();
        let late: u32 = row.deviation[8..].iter().sum();
        assert_eq!(
            late,
            row.deviation.iter().sum::<u32>(),
            "{:?}",
            row.deviation
        );
        let mean = row.deviation_sum / f64::from(row.deviation.iter().sum::<u32>());
        assert!((mean - 420.0).abs() < 30.0, "mean deviation {mean}");
    }

    #[test]
    fn slower_running_shows_in_observed_run_time_against_the_schedule() {
        let mut buffer = RtBuffer::default();
        drive(&mut buffer, "T0", "V1", 7 * 3600, 0, 1.5);
        let result = run_day(&mut buffer);
        let trip = &result.cube.trips[0];
        assert!(trip.complete());
        let ratio = f64::from(trip.observed_run) / f64::from(trip.scheduled_run);
        assert!((ratio - 1.5).abs() < 0.1, "ratio {ratio}");
    }

    #[test]
    fn headways_reflect_bunching_between_consecutive_vehicles() {
        let mut buffer = RtBuffer::default();
        // Scheduled ten minutes apart; the second trip runs 8 minutes early.
        drive(&mut buffer, "T0", "V1", 7 * 3600, 0, 1.0);
        drive(&mut buffer, "T1", "V2", 7 * 3600 + 600, -480, 1.0);
        let result = run_day(&mut buffer);
        let headways = result
            .cube
            .route_hours
            .iter()
            .fold(Headways::default(), |mut sum, r| {
                sum.add(&r.headways);
                sum
            });
        assert!(headways.count >= 4, "{headways:?}");
        let mean = headways.sum / f64::from(headways.count);
        assert!((mean - 120.0).abs() < 30.0, "mean headway {mean}");
        assert_eq!(headways.bunched, headways.count);
    }

    #[test]
    fn scheduled_totals_count_every_active_trip_even_with_no_realtime_data() {
        let mut buffer = RtBuffer::default();
        let result = run_day(&mut buffer);
        assert_eq!(result.cube.quality.trips_scheduled, 12);
        assert_eq!(result.cube.quality.trips_observed, 0);
        let scheduled: u32 = result
            .cube
            .route_hours
            .iter()
            .map(|r| r.trips_scheduled)
            .sum();
        assert_eq!(scheduled, 12);
        // 11 headways at each of 5 stops, all ten minutes.
        let count: u32 = result
            .cube
            .route_hours
            .iter()
            .map(|r| r.sched_headway_count)
            .sum();
        assert_eq!(count, 55);
    }

    #[test]
    fn a_trip_id_with_no_schedule_match_is_counted_and_not_measured() {
        let mut buffer = RtBuffer::default();
        drive(&mut buffer, "UNKNOWN", "V1", 7 * 3600, 0, 1.0);
        let result = run_day(&mut buffer);
        assert!(result.cube.quality.fixes_trip_unmatched > 0);
        assert!(result.cube.trips.is_empty());
    }

    #[test]
    fn a_service_day_runs_past_midnight_utc_without_splitting() {
        // Service at 19:00 local on the 5th is 01:00 UTC on the 6th.
        let mut builder = crate::schedule::ScheduleBuilder::new("x");
        builder.add_route(crate::schedule::RouteMeta {
            id: "R".into(),
            short_name: "1".into(),
            long_name: String::new(),
            route_type: Some(3),
            color: String::new(),
            text_color: String::new(),
        });
        for i in 0..2 {
            builder.add_stop(crate::schedule::StopMeta {
                id: format!("S{i}"),
                code: String::new(),
                name: String::new(),
                lat: 43.0 + 0.04 * f64::from(i),
                lon: -89.0,
            });
        }
        builder.add_calendar("D", [true; 7], 20260101, 20261231);
        builder.add_trip("T", "R", "D", Some(0), None, "");
        builder.add_stop_time("T", "S0", 1, Some(19 * 3600), Some(19 * 3600), None);
        builder.add_stop_time(
            "T",
            "S1",
            2,
            Some(19 * 3600 + 1200),
            Some(19 * 3600 + 1200),
            None,
        );
        let schedule = builder.build().unwrap();

        let mut buffer = RtBuffer::default();
        drive(&mut buffer, "T", "V", 19 * 3600, 0, 1.0);
        let today = process_day(&schedule, &mut buffer, DATE, &clock(), i64::MAX).unwrap();
        assert_eq!(today.cube.trips.len(), 1);
        let tomorrow = process_day(
            &schedule,
            &mut buffer,
            ServiceDate(20261106),
            &clock(),
            i64::MAX,
        )
        .unwrap();
        assert!(
            tomorrow.cube.trips.is_empty(),
            "belongs to one service date only"
        );
    }

    #[test]
    fn a_reported_start_date_overrides_inference() {
        let mut buffer = RtBuffer::default();
        drive(&mut buffer, "T0", "V1", 7 * 3600, 0, 1.0);
        for descriptor in &mut buffer.descriptors {
            descriptor.start_date = 20261104;
        }
        let result = run_day(&mut buffer);
        assert!(result.cube.trips.is_empty());
    }

    #[test]
    fn a_trip_missing_from_the_feed_shows_up_as_a_gap_not_a_normal_headway() {
        let mut buffer = RtBuffer::default();
        // Scheduled every ten minutes. T1 never appears, leaving a 20 minute wait.
        drive(&mut buffer, "T0", "V1", 7 * 3600, 0, 1.0);
        drive(&mut buffer, "T2", "V2", 7 * 3600 + 1200, 0, 1.0);
        let result = run_day(&mut buffer);
        let headways = result
            .cube
            .route_hours
            .iter()
            .fold(Headways::default(), |mut sum, r| {
                sum.add(&r.headways);
                sum
            });
        assert!(headways.count >= 4, "{headways:?}");
        assert_eq!(headways.gapped, headways.count, "{headways:?}");
    }

    #[test]
    fn a_vehicle_swap_mid_trip_still_counts_as_one_observed_trip() {
        let mut buffer = RtBuffer::default();
        drive(&mut buffer, "T0", "V1", 7 * 3600, 0, 1.0);
        drive(&mut buffer, "T0", "V2", 7 * 3600, 30, 1.0);
        let result = run_day(&mut buffer);
        assert_eq!(result.cube.trips.len(), 2, "both runs stay visible");
        assert_eq!(result.cube.quality.trips_observed, 1);
        let observed: u32 = result
            .cube
            .route_hours
            .iter()
            .map(|r| r.trips_observed)
            .sum();
        assert_eq!(observed, 1);
    }

    #[test]
    fn funnel_counts_cover_only_the_hours_a_day_owns() {
        let mut buffer = RtBuffer::default();
        // The evening before this service day starts, still in the buffer.
        drive(&mut buffer, "UNKNOWN", "V1", -6 * 3600, 0, 1.0);
        let result = run_day(&mut buffer);
        assert_eq!(result.cube.quality.fixes_trip_unmatched, 0);
        assert_eq!(result.cube.quality.fixes_unique, 0);
    }

    #[test]
    fn a_vehicle_counts_once_per_hour_even_when_interlined_across_trips() {
        let mut buffer = RtBuffer::default();
        drive(&mut buffer, "T0", "V1", 7 * 3600, 0, 1.0);
        drive(&mut buffer, "T3", "V1", 7 * 3600 + 1800, 0, 1.0);
        let result = run_day(&mut buffer);
        let hour_seven = result.cube.network_vehicles[7];
        assert_eq!(hour_seven, 1, "{:?}", result.cube.network_vehicles);
    }

    #[test]
    fn segment_sums_agree_with_route_sums() {
        let mut buffer = RtBuffer::default();
        drive(&mut buffer, "T0", "V1", 7 * 3600, 0, 1.0);
        let result = run_day(&mut buffer);
        let route_meters: f64 = result.cube.route_hours.iter().map(|r| r.meters).sum();
        let seg_meters: f64 = result
            .cube
            .seg_hours
            .iter()
            .map(|s| f64::from(s.meters))
            .sum();
        assert!(
            (route_meters - seg_meters).abs() < 1.0,
            "{route_meters} vs {seg_meters}"
        );
        let route_seconds: f64 = result.cube.route_hours.iter().map(|r| r.seconds).sum();
        let seg_seconds: f64 = result
            .cube
            .seg_hours
            .iter()
            .map(|s| f64::from(s.seconds))
            .sum();
        assert!(
            (route_seconds - seg_seconds).abs() < 1.0,
            "{route_seconds} vs {seg_seconds}"
        );
    }
}
