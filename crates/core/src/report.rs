//! Merges a selection of days and answers every question the dashboard asks.
//!
//! [`Merged`] adds up the rollups for the chosen days once. Each report then
//! reads the merged sums, so changing a view or a filter costs milliseconds and
//! never touches the source data. Speeds are in meters per second; the interface
//! converts for display.

use crate::cube::{
    self, DEVIATION_BINS, DEVIATION_EDGES, Headways, Quality, RouteHour, StopPeriod, TripRow,
};
use crate::library::Library;
use crate::mode::Mode;
use crate::schedule::{Pattern, RouteMeta};
use crate::time::{SERVICE_HOURS, ServiceDate};
use rustc_hash::{FxHashMap, FxHashSet};
use serde::{Deserialize, Serialize};

/// A cell needs at least this many measured intervals, and at least one for each
/// day selected, before its speed is shown. The CTA scorecard's map used the same
/// one-a-day rule. With 20 s polling a bus crossing a 200 m cell gives about two.
const MIN_CELL_PAIRS: u32 = 2;
/// Slowest-stretch window and how far it keeps from the ends of a line.
const STRETCH_M: f32 = 800.0;
const STRETCH_END_MARGIN_M: f32 = 1609.0;
/// Stops closer than this count as closely spaced (about 800 feet).
const CLOSE_STOP_M: f32 = 244.0;
const BOOTSTRAP_ROUNDS: usize = 1000;
const MAX_HOTSPOTS: usize = 40;
const MAX_HOTSPOT_LENGTH_M: f32 = 1500.0;
/// Service hours searched for a hotspot's worst hour: 5 AM to midnight.
const WORST_HOUR_FROM: usize = 5;
const WORST_HOUR_TO: usize = 24;

/// What the visitor has chosen. Applies to everything on screen.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Selection {
    pub dates: Vec<u32>,
    #[serde(default)]
    pub mode: Mode,
    #[serde(default = "default_early")]
    pub early_s: i32,
    #[serde(default = "default_late")]
    pub late_s: i32,
    #[serde(default)]
    pub periods: Periods,
}

fn default_early() -> i32 {
    -60
}
fn default_late() -> i32 {
    300
}

/// Time periods as `[start, end)` service hours. Defaults match the CTA scorecard.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
pub struct Periods {
    pub am: (u8, u8),
    pub mid: (u8, u8),
    pub pm: (u8, u8),
}

impl Default for Periods {
    fn default() -> Self {
        Self {
            am: (7, 9),
            mid: (10, 14),
            pm: (16, 18),
        }
    }
}

fn in_period(hour: usize, period: (u8, u8)) -> bool {
    (usize::from(period.0)..usize::from(period.1)).contains(&hour)
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Cell {
    pub meters: f32,
    pub seconds: f32,
    pub stopped: f32,
    pub pairs: u32,
}

impl Cell {
    fn add(&mut self, other: &Cell) {
        self.meters += other.meters;
        self.seconds += other.seconds;
        self.stopped += other.stopped;
        self.pairs += other.pairs;
    }

    fn speed(&self, min_pairs: u32) -> Option<f32> {
        (self.seconds > 0.0 && self.pairs >= min_pairs).then(|| self.meters / self.seconds)
    }
}

/// The selected days added together.
pub struct Merged {
    pub selection: Selection,
    pub dates: Vec<u32>,
    pub route_hours: Vec<RouteHour>,
    cells: Vec<Cell>,
    pub stop_periods: Vec<StopPeriod>,
    route_vehicles: FxHashMap<(u32, u8), u32>,
    network_vehicles: [u32; SERVICE_HOURS],
    route_included: Vec<bool>,
}

impl Merged {
    pub fn compute(library: &Library, selection: Selection) -> Self {
        let route_included: Vec<bool> = library
            .routes
            .iter()
            .map(|route| {
                selection.mode == Mode::All
                    || Mode::from_route_type(route.route_type) == selection.mode
            })
            .collect();
        let mut route_hours: FxHashMap<(u32, u8, u8), RouteHour> = FxHashMap::default();
        let mut stop_periods: FxHashMap<(u32, u8, u32, u8), StopPeriod> = FxHashMap::default();
        let mut cells = vec![Cell::default(); library.segs.len() * SERVICE_HOURS];
        let mut route_vehicles: FxHashMap<(u32, u8), u32> = FxHashMap::default();
        let mut network_vehicles = [0_u32; SERVICE_HOURS];
        let mut dates = Vec::new();

        for date in &selection.dates {
            let Some(day) = library.days.get(date) else {
                continue;
            };
            dates.push(*date);
            for row in &day.route_hours {
                if route_included[row.route as usize] {
                    route_hours
                        .entry((row.route, row.dir, row.hour))
                        .and_modify(|sum| sum.add(row))
                        .or_insert_with(|| row.clone());
                }
            }
            for row in &day.seg_hours {
                let seg = &library.segs[row.seg as usize];
                if route_included[seg.key.route as usize] {
                    cells[row.seg as usize * SERVICE_HOURS + usize::from(row.hour)].add(&Cell {
                        meters: row.meters,
                        seconds: row.seconds,
                        stopped: row.stopped_seconds,
                        pairs: row.pairs,
                    });
                }
            }
            for row in &day.stop_periods {
                if route_included[row.route as usize] {
                    stop_periods
                        .entry((row.route, row.dir, row.stop, row.period))
                        .and_modify(|sum| sum.add(row))
                        .or_insert_with(|| row.clone());
                }
            }
            for row in &day.route_vehicles {
                if route_included[row.route as usize] {
                    *route_vehicles.entry((row.route, row.hour)).or_default() += row.vehicles;
                }
            }
            if selection.mode == Mode::All {
                for (slot, value) in network_vehicles.iter_mut().zip(&day.network_vehicles) {
                    *slot += *value;
                }
            }
        }
        // Network vehicle counts can't be split by mode, so a mode filter falls
        // back on the route counts, which can double-count interlined vehicles.
        if selection.mode != Mode::All {
            for ((_, hour), value) in &route_vehicles {
                network_vehicles[usize::from(*hour)] += *value;
            }
        }

        let mut route_hours: Vec<RouteHour> = route_hours.into_values().collect();
        route_hours.sort_by_key(|r| (r.route, r.dir, r.hour));
        let mut stop_periods: Vec<StopPeriod> = stop_periods.into_values().collect();
        stop_periods.sort_by_key(|s| (s.route, s.dir, s.stop, s.period));
        Self {
            selection,
            dates,
            route_hours,
            cells,
            stop_periods,
            route_vehicles,
            network_vehicles,
            route_included,
        }
    }

    fn day_count(&self) -> f64 {
        self.dates.len().max(1) as f64
    }

    /// How many measurements a cell needs before its speed is shown.
    fn min_pairs(&self) -> u32 {
        (self.dates.len() as u32).max(MIN_CELL_PAIRS)
    }

    fn cell(&self, seg: u32, hour: usize) -> &Cell {
        &self.cells[seg as usize * SERVICE_HOURS + hour]
    }

    fn split_deviation(&self, bins: &[u64; DEVIATION_BINS]) -> OnTime {
        let early_edge = cube::deviation_bin(self.selection.early_s);
        let late_edge = cube::deviation_bin(self.selection.late_s);
        let early: u64 = bins[..early_edge].iter().sum();
        let on_time: u64 = bins[early_edge..late_edge].iter().sum();
        let late: u64 = bins[late_edge..].iter().sum();
        OnTime {
            total: early + on_time + late,
            early,
            on_time,
            late,
        }
    }

    /// Trips observed in the selection.
    fn trips<'a>(&'a self, library: &'a Library) -> impl Iterator<Item = (u32, &'a TripRow)> {
        self.dates.iter().flat_map(move |date| {
            library.days[date].trips.iter().filter_map(move |trip| {
                self.route_included[trip.route as usize].then_some((*date, trip))
            })
        })
    }
}

/// Counts of stop passes against the on-time window.
#[derive(Clone, Copy, Debug, Default, Serialize, PartialEq)]
pub struct OnTime {
    pub total: u64,
    pub early: u64,
    pub on_time: u64,
    pub late: u64,
}

fn round3(value: f64) -> f32 {
    ((value * 1000.0).round() / 1000.0) as f32
}

/// A speed from sums, or `None` when nothing was measured.
fn speed_of(meters: f64, seconds: f64) -> Option<f32> {
    (seconds > 0.0).then(|| round3(meters / seconds))
}

fn ratio(numerator: f64, denominator: f64) -> Option<f32> {
    (denominator > 0.0).then(|| round3(numerator / denominator))
}

fn add_bins(sum: &mut [u64; DEVIATION_BINS], bins: &[u32; DEVIATION_BINS]) {
    for (slot, value) in sum.iter_mut().zip(bins) {
        *slot += u64::from(*value);
    }
}

/// Totals over some set of route-hour rows.
#[derive(Clone, Debug, Default)]
struct Totals {
    meters: f64,
    seconds: f64,
    stopped: f64,
    sched_meters: f64,
    sched_seconds: f64,
    trips_scheduled: u64,
    trips_observed: u64,
    service_scheduled: f64,
    service_observed: f64,
    deviation: [u64; DEVIATION_BINS],
    deviation_sum: f64,
    headways: Headways,
    sched_headway_sum: f64,
    sched_headway_squares: f64,
    occupancy: [u64; 9],
}

impl Totals {
    fn add(&mut self, row: &RouteHour) {
        self.meters += row.meters;
        self.seconds += row.seconds;
        self.stopped += row.stopped_seconds;
        self.sched_meters += row.sched_meters;
        self.sched_seconds += row.sched_seconds;
        self.trips_scheduled += u64::from(row.trips_scheduled);
        self.trips_observed += u64::from(row.trips_observed);
        self.service_scheduled += row.service_seconds_scheduled;
        self.service_observed += row.service_seconds_observed;
        add_bins(&mut self.deviation, &row.deviation);
        self.deviation_sum += row.deviation_sum;
        self.headways.add(&row.headways);
        self.sched_headway_sum += row.sched_headway_sum;
        self.sched_headway_squares += row.sched_headway_squares;
        for (slot, value) in self.occupancy.iter_mut().zip(row.occupancy) {
            *slot += u64::from(value);
        }
    }

    fn collect<'a>(rows: impl Iterator<Item = &'a RouteHour>) -> Self {
        let mut totals = Self::default();
        for row in rows {
            totals.add(row);
        }
        totals
    }

    fn speed(&self) -> Option<f32> {
        speed_of(self.meters, self.seconds)
    }

    fn scheduled_speed(&self) -> Option<f32> {
        speed_of(self.sched_meters, self.sched_seconds)
    }

    /// Average wait implied by a set of headways: Σh² / 2Σh.
    fn actual_wait(&self) -> Option<f32> {
        ratio(self.headways.sum_squares, 2.0 * self.headways.sum)
    }

    fn scheduled_wait(&self) -> Option<f32> {
        ratio(self.sched_headway_squares, 2.0 * self.sched_headway_sum)
    }
}

/// Headway measures for frequent service, or `None` when there isn't enough.
#[derive(Clone, Copy, Debug, Serialize, PartialEq)]
pub struct HeadwayStats {
    pub count: u32,
    pub bunched: f32,
    pub gapped: f32,
    pub wait_ok: f32,
    pub actual_wait_s: Option<f32>,
    pub scheduled_wait_s: Option<f32>,
    pub excess_wait_s: Option<f32>,
}

fn headway_stats(totals: &Totals) -> Option<HeadwayStats> {
    let h = totals.headways;
    if h.count < 10 {
        return None;
    }
    let count = f64::from(h.count);
    let (actual, scheduled) = (totals.actual_wait(), totals.scheduled_wait());
    Some(HeadwayStats {
        count: h.count,
        bunched: round3(f64::from(h.bunched) / count),
        gapped: round3(f64::from(h.gapped) / count),
        wait_ok: round3(f64::from(h.wait_ok) / count),
        actual_wait_s: actual,
        scheduled_wait_s: scheduled,
        excess_wait_s: actual.zip(scheduled).map(|(a, s)| a - s),
    })
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct HourRow {
    pub hour: u8,
    pub speed: Option<f32>,
    pub scheduled_speed: Option<f32>,
    pub on_time: OnTime,
    pub trips_scheduled: f32,
    pub trips_observed: f32,
    pub service_hours_scheduled: f32,
    pub service_hours_observed: f32,
    pub vehicles: f32,
    pub stopped_share: Option<f32>,
    pub headways: Option<HeadwayStats>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct DayRow {
    pub date: String,
    pub weekday: u32,
    pub speed: Option<f32>,
    pub peak_speed: Option<f32>,
    pub on_time: OnTime,
    pub trips_scheduled: u32,
    pub trips_observed: u32,
    pub empty_buckets: u32,
    pub service_buckets: u32,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Overview {
    pub dates: Vec<String>,
    pub speed: Option<f32>,
    pub scheduled_speed: Option<f32>,
    pub speed_am: Option<f32>,
    pub speed_mid: Option<f32>,
    pub speed_pm: Option<f32>,
    pub speed_peak: Option<f32>,
    pub on_time: OnTime,
    pub mean_deviation_s: Option<f32>,
    pub deviation_bins: [u64; DEVIATION_BINS],
    pub deviation_edges: [i32; DEVIATION_BINS - 1],
    pub trips_scheduled_per_day: f32,
    pub trips_observed_per_day: f32,
    pub service_hours_scheduled_per_day: f32,
    pub service_hours_observed_per_day: f32,
    pub distance_km_per_day: f32,
    pub peak_vehicles: f32,
    pub stopped_share: Option<f32>,
    pub headways: Option<HeadwayStats>,
    pub hourly: Vec<HourRow>,
    pub days: Vec<DayRow>,
    pub route_count: usize,
}

pub fn overview(library: &Library, merged: &Merged) -> Overview {
    let days = merged.day_count();
    let rows = &merged.route_hours;
    let totals = Totals::collect(rows.iter());
    let periods = merged.selection.periods;
    let period_speed = |period: (u8, u8)| {
        Totals::collect(
            rows.iter()
                .filter(|r| in_period(usize::from(r.hour), period)),
        )
        .speed()
    };
    let peak = Totals::collect(rows.iter().filter(|r| {
        in_period(usize::from(r.hour), periods.am) || in_period(usize::from(r.hour), periods.pm)
    }));

    let mut hourly = Vec::new();
    for hour in 0..SERVICE_HOURS {
        let hour_totals = Totals::collect(rows.iter().filter(|r| usize::from(r.hour) == hour));
        if hour_totals.seconds <= 0.0 && hour_totals.trips_scheduled == 0 {
            continue;
        }
        hourly.push(HourRow {
            hour: hour as u8,
            speed: hour_totals.speed(),
            scheduled_speed: hour_totals.scheduled_speed(),
            on_time: merged.split_deviation(&hour_totals.deviation),
            trips_scheduled: (hour_totals.trips_scheduled as f64 / days) as f32,
            trips_observed: (hour_totals.trips_observed as f64 / days) as f32,
            service_hours_scheduled: (hour_totals.service_scheduled / 3600.0 / days) as f32,
            service_hours_observed: (hour_totals.service_observed / 3600.0 / days) as f32,
            vehicles: (f64::from(merged.network_vehicles[hour]) / days) as f32,
            stopped_share: ratio(hour_totals.stopped, hour_totals.seconds),
            headways: headway_stats(&hour_totals),
        });
    }

    let mut day_rows = Vec::new();
    for date in &merged.dates {
        let day = &library.days[date];
        let included: Vec<&RouteHour> = day
            .route_hours
            .iter()
            .filter(|r| merged.route_included[r.route as usize])
            .collect();
        let day_totals = Totals::collect(included.iter().copied());
        let day_peak = Totals::collect(included.iter().copied().filter(|r| {
            in_period(usize::from(r.hour), periods.am) || in_period(usize::from(r.hour), periods.pm)
        }));
        let service_date = ServiceDate(*date);
        day_rows.push(DayRow {
            date: service_date.to_string(),
            weekday: service_date
                .weekday()
                .map_or(0, |d| d.num_days_from_monday()),
            speed: day_totals.speed(),
            peak_speed: day_peak.speed(),
            on_time: merged.split_deviation(&day_totals.deviation),
            trips_scheduled: day_totals.trips_scheduled as u32,
            trips_observed: day_totals.trips_observed as u32,
            empty_buckets: day.quality.empty_buckets,
            service_buckets: day.quality.service_buckets,
            warnings: day.warnings.clone(),
        });
    }

    let routes: FxHashSet<u32> = rows
        .iter()
        .filter(|r| r.seconds > 0.0)
        .map(|r| r.route)
        .collect();
    let timed = totals.deviation.iter().sum::<u64>() as f64;
    Overview {
        dates: merged
            .dates
            .iter()
            .map(|d| ServiceDate(*d).to_string())
            .collect(),
        speed: totals.speed(),
        scheduled_speed: totals.scheduled_speed(),
        speed_am: period_speed(periods.am),
        speed_mid: period_speed(periods.mid),
        speed_pm: period_speed(periods.pm),
        speed_peak: peak.speed(),
        on_time: merged.split_deviation(&totals.deviation),
        mean_deviation_s: ratio(totals.deviation_sum, timed),
        deviation_bins: totals.deviation,
        deviation_edges: DEVIATION_EDGES,
        trips_scheduled_per_day: (totals.trips_scheduled as f64 / days) as f32,
        trips_observed_per_day: (totals.trips_observed as f64 / days) as f32,
        service_hours_scheduled_per_day: (totals.service_scheduled / 3600.0 / days) as f32,
        service_hours_observed_per_day: (totals.service_observed / 3600.0 / days) as f32,
        distance_km_per_day: (totals.meters / 1000.0 / days) as f32,
        peak_vehicles: merged
            .network_vehicles
            .iter()
            .map(|v| (f64::from(*v) / days) as f32)
            .fold(0.0, f32::max),
        stopped_share: ratio(totals.stopped, totals.seconds),
        headways: headway_stats(&totals),
        hourly,
        days: day_rows,
        route_count: routes.len(),
    }
}

// ---------------------------------------------------------------------------
// Route scorecard
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Stretch {
    pub dir: u8,
    pub from: String,
    pub to: String,
    pub speed: f32,
    pub length_m: f32,
    pub s0: f32,
    pub s1: f32,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct RouteScore {
    pub id: String,
    pub label: String,
    pub long_name: String,
    pub mode: Mode,
    pub color: String,
    pub text_color: String,
    pub trips_scheduled: u64,
    pub trips_observed: u64,
    pub service_hours_per_day: f32,
    pub speed: Option<f32>,
    pub speed_am: Option<f32>,
    pub speed_mid: Option<f32>,
    pub speed_pm: Option<f32>,
    pub speed_peak: Option<f32>,
    pub scheduled_speed: Option<f32>,
    /// Share of the route's length measured in all three periods, so period
    /// speeds compare the same streets.
    pub fixed_coverage: Option<f32>,
    /// `peak / midday - 1`.
    pub peak_change: Option<f32>,
    pub peak_ci: Option<(f32, f32)>,
    pub peak_change_ci: Option<(f32, f32)>,
    pub on_time: OnTime,
    pub mean_deviation_s: Option<f32>,
    pub headways: Option<HeadwayStats>,
    pub run_p50_s: Option<f32>,
    pub run_p90_s: Option<f32>,
    pub run_scheduled_s: Option<f32>,
    pub stopped_share: Option<f32>,
    pub peak_vehicles: f32,
    pub hourly: Vec<Option<f32>>,
    pub slowest: Option<Stretch>,
    pub stops_per_km: Option<f32>,
    pub mean_stop_spacing_m: Option<f32>,
    pub close_stop_share: Option<f32>,
    pub occupancy: [u64; 9],
}

struct RouteContext {
    trips_by_pattern: FxHashMap<u32, Vec<(i32, i32)>>,
    patterns_by_route_dir: FxHashMap<(u32, u8), Vec<u32>>,
    segs_by_route: FxHashMap<u32, Vec<u32>>,
}

impl RouteContext {
    fn new(library: &Library, merged: &Merged) -> Self {
        let mut trips_by_pattern: FxHashMap<u32, Vec<(i32, i32)>> = FxHashMap::default();
        for (_, trip) in merged.trips(library) {
            if trip.complete() {
                trips_by_pattern
                    .entry(trip.pattern)
                    .or_default()
                    .push((trip.observed_run, trip.scheduled_run));
            } else {
                trips_by_pattern.entry(trip.pattern).or_default();
            }
        }
        let mut patterns_by_route_dir: FxHashMap<(u32, u8), Vec<u32>> = FxHashMap::default();
        for (index, pattern) in library.patterns.iter().enumerate() {
            patterns_by_route_dir
                .entry((pattern.route, pattern.dir))
                .or_default()
                .push(index as u32);
        }
        let mut segs_by_route: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
        for (index, seg) in library.segs.iter().enumerate() {
            segs_by_route
                .entry(seg.key.route)
                .or_default()
                .push(index as u32);
        }
        Self {
            trips_by_pattern,
            patterns_by_route_dir,
            segs_by_route,
        }
    }

    /// The pattern most trips ran. Falls back on the schedule's trip count when
    /// nothing was observed, and prefers longer lines to break ties.
    fn dominant_pattern(&self, library: &Library, route: u32, dir: u8) -> Option<u32> {
        let patterns = self.patterns_by_route_dir.get(&(route, dir))?;
        patterns.iter().copied().max_by(|a, b| {
            let key = |index: u32| {
                let observed = self.trips_by_pattern.get(&index).map_or(0, Vec::len);
                (observed, library.patterns[index as usize].trip_count)
            };
            key(*a).cmp(&key(*b)).then(
                library.patterns[*a as usize]
                    .length_m
                    .total_cmp(&library.patterns[*b as usize].length_m),
            )
        })
    }

    fn directions(&self, route: u32) -> Vec<u8> {
        let mut directions: Vec<u8> = [0_u8, 1, 2]
            .into_iter()
            .filter(|dir| self.patterns_by_route_dir.contains_key(&(route, *dir)))
            .collect();
        directions.sort_unstable();
        directions
    }
}

fn percentile(sorted: &[f32], fraction: f32) -> Option<f32> {
    if sorted.is_empty() {
        return None;
    }
    let position = fraction * (sorted.len() - 1) as f32;
    let lower = position.floor() as usize;
    let upper = position.ceil() as usize;
    let weight = position - lower as f32;
    Some(sorted[lower] * (1.0 - weight) + sorted[upper] * weight)
}

/// Speeds by period on a fixed set of segments, so every period is weighted by
/// the same streets. Rush-only trips into slow blocks would otherwise change the
/// mix and look like congestion.
struct FixedSpeeds {
    am: Option<f32>,
    mid: Option<f32>,
    pm: Option<f32>,
    peak: Option<f32>,
    coverage: Option<f32>,
}

fn fixed_speeds(library: &Library, merged: &Merged, segs: &[u32]) -> FixedSpeeds {
    let periods = merged.selection.periods;
    let sum_cells = |seg: u32, keep: &dyn Fn(usize) -> bool| {
        let mut sum = Cell::default();
        for hour in 0..SERVICE_HOURS {
            if keep(hour) {
                sum.add(merged.cell(seg, hour));
            }
        }
        sum
    };
    let (mut weight, mut total_weight) = (0.0_f64, 0.0_f64);
    let (mut am, mut mid, mut pm, mut peak) = (0.0_f64, 0.0_f64, 0.0_f64, 0.0_f64);
    for &seg in segs {
        let length = f64::from(library.segs[seg as usize].length_m);
        total_weight += length;
        let a = sum_cells(seg, &|h| in_period(h, periods.am));
        let m = sum_cells(seg, &|h| in_period(h, periods.mid));
        let p = sum_cells(seg, &|h| in_period(h, periods.pm));
        let min_pairs = merged.min_pairs();
        let usable = |c: &Cell| c.pairs >= min_pairs && c.meters > 0.0;
        if !(usable(&a) && usable(&m) && usable(&p)) {
            continue;
        }
        weight += length;
        // Harmonic: each segment contributes the time it takes at that speed.
        am += length * f64::from(a.seconds) / f64::from(a.meters);
        mid += length * f64::from(m.seconds) / f64::from(m.meters);
        pm += length * f64::from(p.seconds) / f64::from(p.meters);
        let both = a.seconds + p.seconds;
        let both_m = a.meters + p.meters;
        peak += length * f64::from(both) / f64::from(both_m);
    }
    FixedSpeeds {
        am: speed_of(weight, am),
        mid: speed_of(weight, mid),
        pm: speed_of(weight, pm),
        peak: speed_of(weight, peak),
        coverage: ratio(weight, total_weight),
    }
}

/// A low and high bound.
type Interval = (f32, f32);

/// Resamples days to put an interval around a route's peak speed and its peak
/// change. A small deterministic generator keeps the numbers stable on reload.
fn bootstrap_peak(
    library: &Library,
    merged: &Merged,
    route: u32,
) -> (Option<Interval>, Option<Interval>) {
    if merged.dates.len() < 5 {
        return (None, None);
    }
    let periods = merged.selection.periods;
    let daily: Vec<[f64; 4]> = merged
        .dates
        .iter()
        .map(|date| {
            let mut sums = [0.0; 4];
            for row in library.days[date]
                .route_hours
                .iter()
                .filter(|r| r.route == route)
            {
                let hour = usize::from(row.hour);
                if in_period(hour, periods.am) || in_period(hour, periods.pm) {
                    sums[0] += row.meters;
                    sums[1] += row.seconds;
                }
                if in_period(hour, periods.mid) {
                    sums[2] += row.meters;
                    sums[3] += row.seconds;
                }
            }
            sums
        })
        .collect();
    let mut state = 0x9E37_79B9_7F4A_7C15_u64 ^ (u64::from(route) << 17) ^ 1;
    let mut next = move |bound: usize| {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        (state % bound as u64) as usize
    };
    let mut peaks = Vec::with_capacity(BOOTSTRAP_ROUNDS);
    let mut changes = Vec::with_capacity(BOOTSTRAP_ROUNDS);
    for _ in 0..BOOTSTRAP_ROUNDS {
        let mut sums = [0.0; 4];
        for _ in 0..daily.len() {
            let day = daily[next(daily.len())];
            for (slot, value) in sums.iter_mut().zip(day) {
                *slot += value;
            }
        }
        if sums[1] > 0.0 {
            let peak = sums[0] / sums[1];
            peaks.push(peak as f32);
            if sums[3] > 0.0 && sums[2] > 0.0 {
                changes.push((peak / (sums[2] / sums[3]) - 1.0) as f32);
            }
        }
    }
    let interval = |values: &mut Vec<f32>| {
        values.sort_by(f32::total_cmp);
        percentile(values, 0.025).zip(percentile(values, 0.975))
    };
    (interval(&mut peaks), interval(&mut changes))
}

/// The bootstrap resamples pooled day totals, because resampling every segment for
/// every route would be too slow. Reported speeds are fixed-segment, so each
/// interval keeps its width but is moved to surround the figure printed beside it.
fn centered_intervals(
    (peak_interval, change_interval): (Option<Interval>, Option<Interval>),
    rows: &[&RouteHour],
    periods: Periods,
    speed_peak: Option<f32>,
    peak_change: Option<f32>,
) -> (Option<Interval>, Option<Interval>) {
    let is_peak = |hour: usize| in_period(hour, periods.am) || in_period(hour, periods.pm);
    let pooled_peak = Totals::collect(
        rows.iter()
            .copied()
            .filter(|r| is_peak(usize::from(r.hour))),
    )
    .speed();
    let pooled_mid = Totals::collect(
        rows.iter()
            .copied()
            .filter(|r| in_period(usize::from(r.hour), periods.mid)),
    )
    .speed();
    let pooled_change = pooled_peak
        .zip(pooled_mid)
        .and_then(|(peak, mid)| (mid > 0.0).then(|| peak / mid - 1.0));
    let shift = |interval: Option<Interval>, pooled: Option<f32>, reported: Option<f32>| {
        let (low, high) = interval?;
        let offset = reported? - pooled?;
        Some((low + offset, high + offset))
    };
    (
        shift(peak_interval, pooled_peak, speed_peak),
        shift(change_interval, pooled_change, peak_change),
    )
}

/// The slowest stretch of a pattern during `hours`, kept away from the ends of
/// the line where turnarounds and layovers distort speed.
fn slowest_stretch(
    library: &Library,
    merged: &Merged,
    pattern: &Pattern,
    keep_hour: &dyn Fn(usize) -> bool,
) -> Option<Stretch> {
    let margin = if pattern.length_m > 3.0 * STRETCH_END_MARGIN_M {
        STRETCH_END_MARGIN_M
    } else {
        pattern.length_m * 0.1
    };
    let bins: Vec<_> = pattern
        .bins
        .iter()
        .filter(|bin| bin.s0 >= margin && bin.s1 <= pattern.length_m - margin)
        .collect();
    let sums: Vec<Cell> = bins
        .iter()
        .map(|bin| {
            let mut sum = Cell::default();
            for hour in (0..SERVICE_HOURS).filter(|h| keep_hour(*h)) {
                sum.add(merged.cell(bin.seg, hour));
            }
            sum
        })
        .collect();
    let mut best: Option<Stretch> = None;
    let mut start = 0;
    let mut window = Cell::default();
    for end in 0..bins.len() {
        window.add(&sums[end]);
        while start < end && bins[end].s1 - bins[start + 1].s0 >= STRETCH_M {
            window.meters -= sums[start].meters;
            window.seconds -= sums[start].seconds;
            window.pairs -= sums[start].pairs;
            start += 1;
        }
        if bins[end].s1 - bins[start].s0 < STRETCH_M * 0.75 || window.pairs < merged.min_pairs() * 3
        {
            continue;
        }
        if window.seconds <= 0.0 || window.meters <= 0.0 {
            continue;
        }
        let speed = window.meters / window.seconds;
        if best.as_ref().is_none_or(|b| speed < b.speed) {
            best = Some(Stretch {
                dir: pattern.dir,
                from: nearest_stop_name(library, pattern, bins[start].s0),
                to: nearest_stop_name(library, pattern, bins[end].s1),
                speed: round3(f64::from(speed)),
                length_m: bins[end].s1 - bins[start].s0,
                s0: bins[start].s0,
                s1: bins[end].s1,
            });
        }
    }
    best
}

fn nearest_stop_name(library: &Library, pattern: &Pattern, s: f32) -> String {
    pattern
        .stop_s
        .iter()
        .zip(&pattern.stops)
        .min_by(|a, b| (a.0 - s).abs().total_cmp(&(b.0 - s).abs()))
        .map_or_else(String::new, |(_, stop)| {
            library.stops[*stop as usize].name.clone()
        })
}

struct Spacing {
    per_km: f32,
    mean_m: f32,
    close_share: f32,
    gaps: Vec<f32>,
}

fn stop_spacing(pattern: &Pattern) -> Option<Spacing> {
    let gaps: Vec<f32> = pattern
        .stop_s
        .windows(2)
        .map(|pair| pair[1] - pair[0])
        .filter(|gap| *gap > 0.0)
        .collect();
    if gaps.is_empty() {
        return None;
    }
    let length: f32 = gaps.iter().sum();
    Some(Spacing {
        per_km: gaps.len() as f32 / (length / 1000.0),
        mean_m: length / gaps.len() as f32,
        close_share: gaps.iter().filter(|gap| **gap < CLOSE_STOP_M).count() as f32
            / gaps.len() as f32,
        gaps,
    })
}

fn route_score(
    library: &Library,
    merged: &Merged,
    context: &RouteContext,
    route: u32,
) -> RouteScore {
    let meta: &RouteMeta = &library.routes[route as usize];
    let days = merged.day_count();
    let rows: Vec<&RouteHour> = merged
        .route_hours
        .iter()
        .filter(|r| r.route == route)
        .collect();
    let totals = Totals::collect(rows.iter().copied());
    let periods = merged.selection.periods;
    let empty = Vec::new();
    let segs = context.segs_by_route.get(&route).unwrap_or(&empty);
    let fixed = fixed_speeds(library, merged, segs);

    // Fixed-segment speeds when they cover at least half the route; otherwise the
    // route lacks comparable data in some period and pooled speeds are all there is.
    let trustworthy = fixed.coverage.is_some_and(|c| c >= 0.5);
    let pooled = |keep: &dyn Fn(usize) -> bool| {
        Totals::collect(rows.iter().copied().filter(|r| keep(usize::from(r.hour)))).speed()
    };
    let (speed_am, speed_mid, speed_pm, speed_peak) = if trustworthy {
        (fixed.am, fixed.mid, fixed.pm, fixed.peak)
    } else {
        (
            pooled(&|h| in_period(h, periods.am)),
            pooled(&|h| in_period(h, periods.mid)),
            pooled(&|h| in_period(h, periods.pm)),
            pooled(&|h| in_period(h, periods.am) || in_period(h, periods.pm)),
        )
    };

    let peak_change = speed_peak
        .zip(speed_mid)
        .and_then(|(peak, mid)| (mid > 0.0).then(|| round3(f64::from(peak / mid - 1.0))));
    let (peak_ci, peak_change_ci) = centered_intervals(
        bootstrap_peak(library, merged, route),
        &rows,
        periods,
        speed_peak,
        peak_change,
    );

    let hourly: Vec<Option<f32>> = (0..SERVICE_HOURS)
        .map(|hour| {
            Totals::collect(rows.iter().copied().filter(|r| usize::from(r.hour) == hour)).speed()
        })
        .collect();

    let directions = context.directions(route);
    let main_direction = directions
        .iter()
        .copied()
        .max_by_key(|dir| {
            context
                .dominant_pattern(library, route, *dir)
                .map_or(0, |pattern| {
                    context.trips_by_pattern.get(&pattern).map_or(0, Vec::len)
                })
        })
        .unwrap_or(0);
    let main_pattern = context.dominant_pattern(library, route, main_direction);
    let (mut run_p50, mut run_p90, mut run_scheduled) = (None, None, None);
    if let Some(runs) = main_pattern.and_then(|pattern| context.trips_by_pattern.get(&pattern)) {
        let mut observed: Vec<f32> = runs.iter().map(|r| r.0 as f32).collect();
        let mut scheduled: Vec<f32> = runs.iter().map(|r| r.1 as f32).collect();
        observed.sort_by(f32::total_cmp);
        scheduled.sort_by(f32::total_cmp);
        run_p50 = percentile(&observed, 0.5);
        run_p90 = percentile(&observed, 0.9);
        run_scheduled = percentile(&scheduled, 0.5);
    }
    let spacing =
        main_pattern.and_then(|pattern| stop_spacing(&library.patterns[pattern as usize]));

    let rush = |hour: usize| in_period(hour, periods.am) || in_period(hour, periods.pm);
    let slowest = directions
        .iter()
        .filter_map(|dir| context.dominant_pattern(library, route, *dir))
        .filter_map(|pattern| {
            slowest_stretch(library, merged, &library.patterns[pattern as usize], &rush)
        })
        .min_by(|a, b| a.speed.total_cmp(&b.speed));

    RouteScore {
        id: meta.id.clone(),
        label: meta.label().to_owned(),
        long_name: meta.long_name.clone(),
        mode: Mode::from_route_type(meta.route_type),
        color: meta.color.clone(),
        text_color: meta.text_color.clone(),
        trips_scheduled: totals.trips_scheduled,
        trips_observed: totals.trips_observed,
        service_hours_per_day: (totals.service_observed / 3600.0 / days) as f32,
        speed: totals.speed(),
        speed_am,
        speed_mid,
        speed_pm,
        speed_peak,
        scheduled_speed: totals.scheduled_speed(),
        fixed_coverage: fixed.coverage,
        peak_change,
        peak_ci,
        peak_change_ci,
        on_time: merged.split_deviation(&totals.deviation),
        mean_deviation_s: ratio(
            totals.deviation_sum,
            totals.deviation.iter().sum::<u64>() as f64,
        ),
        headways: headway_stats(&totals),
        run_p50_s: run_p50,
        run_p90_s: run_p90,
        run_scheduled_s: run_scheduled,
        stopped_share: ratio(totals.stopped, totals.seconds),
        peak_vehicles: (0..SERVICE_HOURS as u8)
            .map(|hour| {
                merged
                    .route_vehicles
                    .get(&(route, hour))
                    .copied()
                    .unwrap_or(0) as f32
                    / days as f32
            })
            .fold(0.0, f32::max),
        hourly,
        slowest,
        stops_per_km: spacing.as_ref().map(|s| s.per_km),
        mean_stop_spacing_m: spacing.as_ref().map(|s| s.mean_m),
        close_stop_share: spacing.as_ref().map(|s| s.close_share),
        occupancy: totals.occupancy,
    }
}

/// One scorecard row per route with any scheduled or observed service.
pub fn route_scores(library: &Library, merged: &Merged) -> Vec<RouteScore> {
    let context = RouteContext::new(library, merged);
    let routes: FxHashSet<u32> = merged
        .route_hours
        .iter()
        .filter(|r| r.trips_scheduled > 0 || r.seconds > 0.0)
        .map(|r| r.route)
        .collect();
    let mut scores: Vec<RouteScore> = routes
        .into_iter()
        .map(|route| route_score(library, merged, &context, route))
        .collect();
    scores.sort_by_key(|score| natural_key(&score.label));
    scores
}

/// Sorts `2` before `10` and letters after numbers.
fn natural_key(label: &str) -> (u32, String) {
    let digits: String = label.chars().take_while(char::is_ascii_digit).collect();
    (digits.parse().unwrap_or(u32::MAX), label.to_owned())
}

// ---------------------------------------------------------------------------
// Network map
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct MapFeature {
    pub id: u32,
    pub path: Vec<[f32; 2]>,
    pub length_m: f32,
    pub routes: Vec<String>,
    /// Speed per service hour.
    pub speeds: Vec<Option<f32>>,
    pub all_day: Option<f32>,
    pub am: Option<f32>,
    pub mid: Option<f32>,
    pub pm: Option<f32>,
    pub measurements: u32,
    pub bus_hours_per_day: f32,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct MapHour {
    pub hour: u8,
    pub speed: Option<f32>,
    pub cells: u32,
    pub slow_share: Option<f32>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct NetworkMap {
    pub center: (f64, f64),
    pub features: Vec<MapFeature>,
    pub hours: Vec<MapHour>,
    pub bounds: Option<[f32; 4]>,
}

/// Streets below this speed count toward the "slow" share (8 mph).
const SLOW_MPS: f32 = 3.576;

/// Pools every route through each directional street cell. `route` limits the
/// map to one route.
pub fn network_map(library: &Library, merged: &Merged, route: Option<&str>) -> NetworkMap {
    let days = merged.day_count() as f32;
    let periods = merged.selection.periods;
    let only = route.and_then(|id| library.route_index(id));
    let min_pairs = merged.min_pairs();
    let mut features = Vec::new();
    let mut hour_sums = vec![(Cell::default(), 0_u32, 0_u32); SERVICE_HOURS];
    let mut bounds: Option<[f32; 4]> = None;

    for (corridor_index, corridor) in library.corridors.iter().enumerate() {
        let segs: Vec<u32> = corridor
            .segs
            .iter()
            .copied()
            .filter(|seg| only.is_none_or(|route| library.segs[*seg as usize].key.route == route))
            .collect();
        if segs.is_empty() {
            continue;
        }
        let mut hours = [Cell::default(); SERVICE_HOURS];
        for seg in &segs {
            for (hour, sum) in hours.iter_mut().enumerate() {
                sum.add(merged.cell(*seg, hour));
            }
        }
        let measurements: u32 = hours.iter().map(|c| c.pairs).sum();
        if measurements < min_pairs {
            continue;
        }
        let total = hours.iter().fold(Cell::default(), |mut sum, cell| {
            sum.add(cell);
            sum
        });
        let period_speed = |period: (u8, u8)| {
            let mut sum = Cell::default();
            for (hour, cell) in hours.iter().enumerate() {
                if in_period(hour, period) {
                    sum.add(cell);
                }
            }
            sum.speed(min_pairs).map(|s| round3(f64::from(s)))
        };
        let speeds: Vec<Option<f32>> = hours
            .iter()
            .map(|cell| cell.speed(min_pairs).map(|s| round3(f64::from(s))))
            .collect();
        for (hour, cell) in hours.iter().enumerate() {
            let slot = &mut hour_sums[hour];
            slot.0.add(cell);
            if let Some(speed) = cell.speed(min_pairs) {
                slot.1 += 1;
                if speed < SLOW_MPS {
                    slot.2 += 1;
                }
            }
        }
        let mut route_labels: Vec<String> = segs
            .iter()
            .filter(|seg| (0..SERVICE_HOURS).any(|hour| merged.cell(**seg, hour).pairs > 0))
            .map(|seg| {
                library.routes[library.segs[*seg as usize].key.route as usize]
                    .label()
                    .to_owned()
            })
            .collect();
        route_labels.sort_by_key(|label| natural_key(label));
        route_labels.dedup();
        let representative = segs
            .iter()
            .copied()
            .max_by(|a, b| {
                library.segs[*a as usize]
                    .length_m
                    .total_cmp(&library.segs[*b as usize].length_m)
            })
            .unwrap_or(corridor.representative);
        let meta = &library.segs[representative as usize];
        for point in &meta.path {
            let b = bounds.get_or_insert([point[0], point[1], point[0], point[1]]);
            b[0] = b[0].min(point[0]);
            b[1] = b[1].min(point[1]);
            b[2] = b[2].max(point[0]);
            b[3] = b[3].max(point[1]);
        }
        features.push(MapFeature {
            id: corridor_index as u32,
            path: meta.path.clone(),
            length_m: meta.length_m,
            routes: route_labels,
            speeds,
            all_day: total.speed(min_pairs).map(|s| round3(f64::from(s))),
            am: period_speed(periods.am),
            mid: period_speed(periods.mid),
            pm: period_speed(periods.pm),
            measurements,
            bus_hours_per_day: total.seconds / 3600.0 / days,
        });
    }
    let hours = hour_sums
        .iter()
        .enumerate()
        .filter(|(_, slot)| slot.1 > 0)
        .map(|(hour, slot)| MapHour {
            hour: hour as u8,
            speed: slot.0.speed(min_pairs),
            cells: slot.1,
            slow_share: ratio(f64::from(slot.2), f64::from(slot.1)),
        })
        .collect();
    NetworkMap {
        center: library.center,
        features,
        hours,
        bounds,
    }
}

// ---------------------------------------------------------------------------
// Delay hotspots
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Hotspot {
    pub rank: u32,
    pub from: String,
    pub to: String,
    pub routes: Vec<String>,
    pub length_m: f32,
    pub delay_hours_per_day: f32,
    pub bus_hours_per_day: f32,
    pub reference_speed: f32,
    pub worst_speed: f32,
    pub worst_hour: u8,
    pub peak_speed: Option<f32>,
    pub stopped_share: Option<f32>,
    pub path: Vec<[f32; 2]>,
    pub hourly: Vec<Option<f32>>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct HotspotReport {
    pub delay_hours_per_day: f32,
    pub bus_hours_per_day: f32,
    pub hotspots: Vec<Hotspot>,
}

struct CorridorStat {
    hours: [Cell; SERVICE_HOURS],
    reference: Option<f32>,
    delay_seconds: f32,
    length: f32,
}

/// Time lost on each street cell compared with that cell's own freest conditions
/// (the 85th percentile of its hourly speeds), and the contiguous runs of cells
/// losing the most.
pub fn hotspots(library: &Library, merged: &Merged) -> HotspotReport {
    let days = merged.day_count() as f32;
    let stats: Vec<CorridorStat> = library
        .corridors
        .iter()
        .map(|corridor| {
            let mut hours = [Cell::default(); SERVICE_HOURS];
            for seg in &corridor.segs {
                for (hour, sum) in hours.iter_mut().enumerate() {
                    sum.add(merged.cell(*seg, hour));
                }
            }
            let min_pairs = merged.min_pairs();
            let mut speeds: Vec<f32> = hours.iter().filter_map(|c| c.speed(min_pairs)).collect();
            speeds.sort_by(f32::total_cmp);
            let reference = (speeds.len() >= 3)
                .then(|| percentile(&speeds, 0.85))
                .flatten()
                .filter(|speed| *speed > 0.0);
            let delay_seconds = reference.map_or(0.0, |reference| {
                hours
                    .iter()
                    .map(|cell| (cell.seconds - cell.meters / reference).max(0.0))
                    .sum()
            });
            CorridorStat {
                hours,
                reference,
                delay_seconds,
                length: library.segs[corridor.representative as usize].length_m,
            }
        })
        .collect();

    let total_delay: f32 = stats.iter().map(|s| s.delay_seconds).sum();
    let total_bus: f32 = stats
        .iter()
        .map(|s| s.hours.iter().map(|c| c.seconds).sum::<f32>())
        .sum();

    // Which cell usually follows which, from every pattern's line. Weighted by
    // trips so the main line wins over short variants.
    let mut next: FxHashMap<u32, FxHashMap<u32, u32>> = FxHashMap::default();
    let mut previous: FxHashMap<u32, FxHashMap<u32, u32>> = FxHashMap::default();
    for pattern in &library.patterns {
        let weight = pattern.trip_count.max(1);
        for pair in pattern.bins.windows(2) {
            let (a, b) = (
                library.seg_corridor[pair[0].seg as usize],
                library.seg_corridor[pair[1].seg as usize],
            );
            if a != b {
                *next.entry(a).or_default().entry(b).or_default() += weight;
                *previous.entry(b).or_default().entry(a).or_default() += weight;
            }
        }
    }
    let best = |map: &FxHashMap<u32, FxHashMap<u32, u32>>, at: u32| {
        map.get(&at).and_then(|options| {
            options
                .iter()
                .max_by_key(|(id, weight)| (**weight, std::cmp::Reverse(**id)))
                .map(|(id, _)| *id)
        })
    };
    let density = |stat: &CorridorStat| stat.delay_seconds / stat.length.max(1.0);

    let mut order: Vec<u32> = (0..stats.len() as u32)
        .filter(|index| stats[*index as usize].delay_seconds > 0.0)
        .collect();
    order.sort_by(|a, b| {
        density(&stats[*b as usize])
            .total_cmp(&density(&stats[*a as usize]))
            .then(a.cmp(b))
    });

    let mut used: FxHashSet<u32> = FxHashSet::default();
    let mut found: Vec<Hotspot> = Vec::new();
    for seed in order {
        if found.len() >= MAX_HOTSPOTS * 3 {
            break;
        }
        if used.contains(&seed) || stats[seed as usize].length < 20.0 {
            continue;
        }
        let threshold = density(&stats[seed as usize]) * 0.35;
        let mut run: Vec<u32> = vec![seed];
        let mut length = stats[seed as usize].length;
        used.insert(seed);
        let mut extend = |run: &mut Vec<u32>, length: &mut f32, forward: bool| {
            let mut at = if forward { run[run.len() - 1] } else { run[0] };
            while *length < MAX_HOTSPOT_LENGTH_M {
                let map = if forward { &next } else { &previous };
                let Some(candidate) = best(map, at) else {
                    break;
                };
                let stat = &stats[candidate as usize];
                if used.contains(&candidate) || density(stat) < threshold {
                    break;
                }
                used.insert(candidate);
                *length += stat.length;
                if forward {
                    run.push(candidate);
                } else {
                    run.insert(0, candidate);
                }
                at = candidate;
            }
        };
        extend(&mut run, &mut length, true);
        extend(&mut run, &mut length, false);
        found.push(build_hotspot(library, merged, &stats, &run, length, days));
    }
    found.sort_by(|a, b| b.delay_hours_per_day.total_cmp(&a.delay_hours_per_day));
    found.truncate(MAX_HOTSPOTS);
    for (rank, hotspot) in found.iter_mut().enumerate() {
        hotspot.rank = rank as u32 + 1;
    }
    HotspotReport {
        delay_hours_per_day: total_delay / 3600.0 / days,
        bus_hours_per_day: total_bus / 3600.0 / days,
        hotspots: found,
    }
}

fn build_hotspot(
    library: &Library,
    merged: &Merged,
    stats: &[CorridorStat],
    run: &[u32],
    length: f32,
    days: f32,
) -> Hotspot {
    let min_pairs = merged.min_pairs();
    let mut hours = [Cell::default(); SERVICE_HOURS];
    let mut delay = 0.0_f32;
    let mut routes: Vec<String> = Vec::new();
    let mut path: Vec<[f32; 2]> = Vec::new();
    let mut reference_weighted = 0.0_f32;
    for corridor in run {
        let stat = &stats[*corridor as usize];
        delay += stat.delay_seconds;
        reference_weighted += stat.reference.unwrap_or(0.0) * stat.length;
        for (sum, cell) in hours.iter_mut().zip(stat.hours) {
            sum.add(&cell);
        }
        let meta = &library.corridors[*corridor as usize];
        for seg in &meta.segs {
            if (0..SERVICE_HOURS).any(|hour| merged.cell(*seg, hour).pairs > 0) {
                routes.push(
                    library.routes[library.segs[*seg as usize].key.route as usize]
                        .label()
                        .to_owned(),
                );
            }
        }
        let line = &library.segs[meta.representative as usize].path;
        path.extend_from_slice(line);
    }
    routes.sort_by_key(|label| natural_key(label));
    routes.dedup();
    // Daytime and evening only: a few fast or slow overnight trips say little.
    let (worst_hour, worst_speed) = hours
        .iter()
        .enumerate()
        .filter(|(hour, _)| (WORST_HOUR_FROM..WORST_HOUR_TO).contains(hour))
        .filter_map(|(hour, cell)| cell.speed(min_pairs).map(|speed| (hour, speed)))
        .min_by(|a, b| a.1.total_cmp(&b.1))
        .unwrap_or((0, 0.0));
    let periods = merged.selection.periods;
    let mut peak = Cell::default();
    let mut total = Cell::default();
    for (hour, cell) in hours.iter().enumerate() {
        total.add(cell);
        if in_period(hour, periods.am) || in_period(hour, periods.pm) {
            peak.add(cell);
        }
    }
    let (from, to) = stretch_names(library, &path);
    Hotspot {
        rank: 0,
        from,
        to,
        routes,
        length_m: length,
        delay_hours_per_day: delay / 3600.0 / days,
        bus_hours_per_day: total.seconds / 3600.0 / days,
        reference_speed: round3(f64::from(reference_weighted / length.max(1.0))),
        worst_speed: round3(f64::from(worst_speed)),
        worst_hour: worst_hour as u8,
        peak_speed: peak.speed(min_pairs).map(|s| round3(f64::from(s))),
        stopped_share: ratio(f64::from(total.stopped), f64::from(total.seconds)),
        hourly: hours
            .iter()
            .map(|cell| cell.speed(min_pairs).map(|s| round3(f64::from(s))))
            .collect(),
        path,
    }
}

/// Names a stretch by the stops closest to its two ends.
fn stretch_names(library: &Library, path: &[[f32; 2]]) -> (String, String) {
    let nearest = |point: [f32; 2]| {
        let k = f64::from(point[1]).to_radians().cos();
        library
            .stops
            .iter()
            .min_by(|a, b| {
                let distance = |stop: &crate::schedule::StopMeta| {
                    let dx = (stop.lon - f64::from(point[0])) * k;
                    let dy = stop.lat - f64::from(point[1]);
                    dx * dx + dy * dy
                };
                distance(a).total_cmp(&distance(b))
            })
            .map_or_else(String::new, |stop| stop.name.clone())
    };
    match (path.first(), path.last()) {
        (Some(first), Some(last)) => (nearest(*first), nearest(*last)),
        _ => (String::new(), String::new()),
    }
}

// ---------------------------------------------------------------------------
// One route in depth
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct ProfileBin {
    pub s0: f32,
    pub s1: f32,
    pub speeds: Vec<Option<f32>>,
    pub measurements: u32,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct RouteStop {
    pub id: String,
    pub name: String,
    pub lat: f64,
    pub lon: f64,
    pub s: f32,
    pub passes: u32,
    pub scheduled: u32,
    pub zone_seconds: Option<f32>,
    /// Mean schedule deviation per stop period.
    pub deviation_by_period: Vec<Option<f32>>,
    pub deviation: Option<f32>,
    pub on_time: OnTime,
    pub headways: Option<HeadwayStats>,
    pub gap_to_next_m: Option<f32>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct RunTimeRow {
    pub hour: u8,
    pub count: u32,
    pub p10: f32,
    pub p50: f32,
    pub p90: f32,
    pub scheduled: f32,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct DirectionHour {
    pub hour: u8,
    pub speed: Option<f32>,
    pub scheduled_speed: Option<f32>,
    pub on_time: OnTime,
    pub trips_scheduled: u32,
    pub trips_observed: u32,
    pub headways: Option<HeadwayStats>,
    pub actual_headway_s: Option<f32>,
    pub scheduled_headway_s: Option<f32>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct PatternSummary {
    pub index: u32,
    pub headsign: String,
    pub stops: usize,
    pub length_m: f32,
    pub trips_observed: usize,
    pub trips_scheduled: u32,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct DirectionDetail {
    pub dir: u8,
    pub headsign: String,
    pub pattern: u32,
    pub patterns: Vec<PatternSummary>,
    pub length_m: f32,
    pub path: Vec<[f32; 2]>,
    pub profile: Vec<ProfileBin>,
    pub stops: Vec<RouteStop>,
    pub hourly: Vec<DirectionHour>,
    pub run_times: Vec<RunTimeRow>,
    pub slowest: Option<Stretch>,
    pub stop_gaps_m: Vec<f32>,
    pub stops_per_km: Option<f32>,
    pub mean_stop_spacing_m: Option<f32>,
    pub close_stop_share: Option<f32>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct RouteDetail {
    pub score: RouteScore,
    pub directions: Vec<DirectionDetail>,
    pub dates: Vec<String>,
}

pub fn route_detail(library: &Library, merged: &Merged, route_id: &str) -> Option<RouteDetail> {
    let route = library.route_index(route_id)?;
    let context = RouteContext::new(library, merged);
    let directions = context
        .directions(route)
        .into_iter()
        .filter_map(|dir| direction_detail(library, merged, &context, route, dir))
        .collect();
    Some(RouteDetail {
        score: route_score(library, merged, &context, route),
        directions,
        dates: merged
            .dates
            .iter()
            .map(|d| ServiceDate(*d).to_string())
            .collect(),
    })
}

fn direction_detail(
    library: &Library,
    merged: &Merged,
    context: &RouteContext,
    route: u32,
    dir: u8,
) -> Option<DirectionDetail> {
    let pattern_index = context.dominant_pattern(library, route, dir)?;
    let pattern = &library.patterns[pattern_index as usize];
    let rush = {
        let periods = merged.selection.periods;
        move |hour: usize| in_period(hour, periods.am) || in_period(hour, periods.pm)
    };

    let profile = pattern
        .bins
        .iter()
        .map(|bin| {
            let mut speeds = Vec::with_capacity(SERVICE_HOURS);
            let mut measurements = 0;
            for hour in 0..SERVICE_HOURS {
                let cell = merged.cell(bin.seg, hour);
                measurements += cell.pairs;
                speeds.push(cell.speed(merged.min_pairs()).map(|s| round3(f64::from(s))));
            }
            ProfileBin {
                s0: bin.s0,
                s1: bin.s1,
                speeds,
                measurements,
            }
        })
        .collect();

    let mut stops = Vec::with_capacity(pattern.stops.len());
    for (index, stop) in pattern.stops.iter().enumerate() {
        let meta = &library.stops[*stop as usize];
        let rows: Vec<&StopPeriod> = merged
            .stop_periods
            .iter()
            .filter(|row| row.route == route && row.dir == dir && row.stop == *stop)
            .collect();
        let mut bins = [0_u64; DEVIATION_BINS];
        let mut sum = StopPeriod::default();
        let mut by_period = vec![None; cube::STOP_PERIODS];
        for row in &rows {
            add_bins(&mut bins, &row.deviation);
            sum.add(row);
            let count: u32 = row.deviation.iter().sum();
            by_period[usize::from(row.period)] = ratio(row.deviation_sum, f64::from(count));
        }
        let totals = Totals {
            headways: sum.headways,
            ..Totals::default()
        };
        stops.push(RouteStop {
            id: meta.id.clone(),
            name: meta.name.clone(),
            lat: meta.lat,
            lon: meta.lon,
            s: pattern.stop_s[index],
            passes: sum.passes,
            scheduled: sum.scheduled,
            zone_seconds: ratio(f64::from(sum.zone_seconds), f64::from(sum.zone_count)),
            deviation_by_period: by_period,
            deviation: ratio(sum.deviation_sum, bins.iter().sum::<u64>() as f64),
            on_time: merged.split_deviation(&bins),
            headways: headway_stats(&totals),
            gap_to_next_m: pattern
                .stop_s
                .get(index + 1)
                .map(|next| next - pattern.stop_s[index]),
        });
    }

    let hourly = merged
        .route_hours
        .iter()
        .filter(|row| row.route == route && row.dir == dir)
        .map(|row| {
            let totals = Totals::collect(std::iter::once(row));
            DirectionHour {
                hour: row.hour,
                speed: totals.speed(),
                scheduled_speed: totals.scheduled_speed(),
                on_time: merged.split_deviation(&totals.deviation),
                trips_scheduled: row.trips_scheduled,
                trips_observed: row.trips_observed,
                headways: headway_stats(&totals),
                actual_headway_s: ratio(row.headways.sum, f64::from(row.headways.count)),
                scheduled_headway_s: ratio(
                    row.sched_headway_sum,
                    f64::from(row.sched_headway_count),
                ),
            }
        })
        .collect();

    let mut runs_by_hour: FxHashMap<u8, (Vec<f32>, Vec<f32>)> = FxHashMap::default();
    for (_, trip) in merged.trips(library) {
        if trip.pattern == pattern_index && trip.complete() {
            let hour = crate::time::service_hour(i64::from(trip.sched_start)) as u8;
            let entry = runs_by_hour.entry(hour).or_default();
            entry.0.push(trip.observed_run as f32);
            entry.1.push(trip.scheduled_run as f32);
        }
    }
    let mut run_times: Vec<RunTimeRow> = runs_by_hour
        .into_iter()
        .filter_map(|(hour, (mut observed, mut scheduled))| {
            observed.sort_by(f32::total_cmp);
            scheduled.sort_by(f32::total_cmp);
            Some(RunTimeRow {
                hour,
                count: observed.len() as u32,
                p10: percentile(&observed, 0.1)?,
                p50: percentile(&observed, 0.5)?,
                p90: percentile(&observed, 0.9)?,
                scheduled: percentile(&scheduled, 0.5)?,
            })
        })
        .collect();
    run_times.sort_by_key(|row| row.hour);

    let patterns = context
        .patterns_by_route_dir
        .get(&(route, dir))
        .map(|indexes| {
            let mut list: Vec<PatternSummary> = indexes
                .iter()
                .map(|index| {
                    let item = &library.patterns[*index as usize];
                    PatternSummary {
                        index: *index,
                        headsign: item.headsign.clone(),
                        stops: item.stops.len(),
                        length_m: item.length_m,
                        trips_observed: context.trips_by_pattern.get(index).map_or(0, Vec::len),
                        trips_scheduled: item.trip_count,
                    }
                })
                .collect();
            list.sort_by_key(|item| std::cmp::Reverse(item.trips_observed));
            list
        })
        .unwrap_or_default();

    let spacing = stop_spacing(pattern);
    Some(DirectionDetail {
        dir,
        headsign: pattern.headsign.clone(),
        pattern: pattern_index,
        patterns,
        length_m: pattern.length_m,
        path: pattern.path.clone(),
        profile,
        stops,
        hourly,
        run_times,
        slowest: slowest_stretch(library, merged, pattern, &rush),
        stops_per_km: spacing.as_ref().map(|s| s.per_km),
        mean_stop_spacing_m: spacing.as_ref().map(|s| s.mean_m),
        close_stop_share: spacing.as_ref().map(|s| s.close_share),
        stop_gaps_m: spacing.map(|s| s.gaps).unwrap_or_default(),
    })
}

// ---------------------------------------------------------------------------
// String-line (Marey) chart
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct StringLineTrip {
    pub trip_id: String,
    pub vehicle: String,
    pub deviation_end_s: Option<i32>,
    /// Observed `(seconds from origin, meters along the main pattern)`.
    pub observed: Vec<(i32, f32)>,
    pub scheduled: Vec<(i32, f32)>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct StringLine {
    pub date: String,
    pub route: String,
    pub dir: u8,
    pub length_m: f32,
    pub stops: Vec<(f32, String)>,
    pub trips: Vec<StringLineTrip>,
}

/// Every trip on a route and direction for one day, placed on the main pattern's
/// distance axis through the stops they share.
pub fn string_line(
    library: &Library,
    merged: &Merged,
    route_id: &str,
    dir: u8,
    date: u32,
) -> Option<StringLine> {
    let route = library.route_index(route_id)?;
    let context = RouteContext::new(library, merged);
    let pattern_index = context.dominant_pattern(library, route, dir)?;
    let main = &library.patterns[pattern_index as usize];
    let day = library.days.get(&date)?;
    let events = library.events.get(&date)?;
    // A stop can sit on the main line more than once, on a loop or an out-and-back.
    let mut positions: FxHashMap<u32, Vec<f32>> = FxHashMap::default();
    for (stop, s) in main.stops.iter().zip(&main.stop_s) {
        positions.entry(*stop).or_default().push(*s);
    }

    /// `(seconds from origin, meters along the line)` points.
    type Points = Vec<(i32, f32)>;
    let mut by_trip: FxHashMap<u32, (Points, Points)> = FxHashMap::default();
    for event in events {
        let Some(trip) = day.trips.get(event.trip as usize) else {
            continue;
        };
        if trip.route != route || trip.dir != dir {
            continue;
        }
        let index = usize::from(event.stop_index);
        let entry = by_trip.entry(event.trip).or_default();
        let s = if trip.pattern == pattern_index {
            main.stop_s.get(index).copied()
        } else {
            // Other patterns join through shared stops, taking the first place
            // on the main line that doesn't move the trip backward.
            let pattern = &library.patterns[trip.pattern as usize];
            let previous = entry.0.last().map_or(f32::MIN, |point| point.1);
            pattern
                .stops
                .get(index)
                .and_then(|stop| positions.get(stop))
                .and_then(|places| places.iter().copied().find(|s| *s >= previous))
        };
        let Some(s) = s else {
            continue;
        };
        entry.0.push((event.observed, s));
        entry.1.push((event.scheduled, s));
    }
    let mut trips: Vec<StringLineTrip> = by_trip
        .into_iter()
        .map(|(index, (observed, scheduled))| {
            let trip = &day.trips[index as usize];
            StringLineTrip {
                trip_id: trip.trip_id.clone(),
                vehicle: trip.vehicle.clone(),
                deviation_end_s: trip.end_deviation,
                observed,
                scheduled,
            }
        })
        .collect();
    trips.sort_by_key(|trip| trip.scheduled.first().map_or(0, |p| p.0));
    Some(StringLine {
        date: ServiceDate(date).to_string(),
        route: route_id.to_owned(),
        dir,
        length_m: main.length_m,
        stops: main
            .stops
            .iter()
            .zip(&main.stop_s)
            .map(|(stop, s)| (*s, library.stops[*stop as usize].name.clone()))
            .collect(),
        trips,
    })
}

// ---------------------------------------------------------------------------
// Stops
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct StopRow {
    pub id: String,
    pub code: String,
    pub name: String,
    pub lat: f64,
    pub lon: f64,
    pub routes: Vec<String>,
    pub passes_per_day: f32,
    pub scheduled_per_day: f32,
    pub zone_seconds: Option<f32>,
    pub zone_hours_per_day: f32,
    pub mean_deviation_s: Option<f32>,
    pub on_time: OnTime,
    /// Shortest distance to a neighbouring stop on any route here.
    pub nearest_stop_m: Option<f32>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct RouteSpacing {
    pub route: String,
    pub label: String,
    pub dir: u8,
    pub headsign: String,
    pub stops: usize,
    pub mean_m: f32,
    pub median_m: f32,
    pub per_km: f32,
    pub close_share: f32,
    pub zone_share: Option<f32>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct StopsReport {
    pub stops: Vec<StopRow>,
    pub spacing: Vec<RouteSpacing>,
    pub spacing_histogram: Vec<u32>,
    pub spacing_bin_m: f32,
    pub close_threshold_m: f32,
}

pub fn stops_report(library: &Library, merged: &Merged) -> StopsReport {
    let days = merged.day_count() as f32;
    let context = RouteContext::new(library, merged);
    let mut nearest: FxHashMap<u32, f32> = FxHashMap::default();
    let mut spacing = Vec::new();
    const HISTOGRAM_BIN: f32 = 50.0;
    let mut histogram = vec![0_u32; 40];

    let route_ids: FxHashSet<u32> = merged.route_hours.iter().map(|r| r.route).collect();
    let mut zones_by_route_dir: FxHashMap<(u32, u8), f64> = FxHashMap::default();
    for row in &merged.stop_periods {
        *zones_by_route_dir.entry((row.route, row.dir)).or_default() += f64::from(row.zone_seconds);
    }
    let seconds_by_route_dir: FxHashMap<(u32, u8), f64> = {
        let mut map = FxHashMap::default();
        for row in &merged.route_hours {
            *map.entry((row.route, row.dir)).or_default() += row.seconds;
        }
        map
    };
    for route in route_ids {
        for dir in context.directions(route) {
            let Some(pattern_index) = context.dominant_pattern(library, route, dir) else {
                continue;
            };
            let pattern = &library.patterns[pattern_index as usize];
            let Some(stats) = stop_spacing(pattern) else {
                continue;
            };
            for gap in &stats.gaps {
                let bin = ((gap / HISTOGRAM_BIN) as usize).min(histogram.len() - 1);
                histogram[bin] += 1;
            }
            let mut sorted = stats.gaps.clone();
            sorted.sort_by(f32::total_cmp);
            let meta = &library.routes[route as usize];
            spacing.push(RouteSpacing {
                route: meta.id.clone(),
                label: meta.label().to_owned(),
                dir,
                headsign: pattern.headsign.clone(),
                stops: pattern.stops.len(),
                mean_m: stats.mean_m,
                median_m: percentile(&sorted, 0.5).unwrap_or(0.0),
                per_km: stats.per_km,
                close_share: stats.close_share,
                zone_share: ratio(
                    zones_by_route_dir
                        .get(&(route, dir))
                        .copied()
                        .unwrap_or(0.0),
                    seconds_by_route_dir
                        .get(&(route, dir))
                        .copied()
                        .unwrap_or(0.0),
                ),
            });
            for (index, stop) in pattern.stops.iter().enumerate() {
                let before = index
                    .checked_sub(1)
                    .map(|i| pattern.stop_s[index] - pattern.stop_s[i]);
                let after = pattern
                    .stop_s
                    .get(index + 1)
                    .map(|s| s - pattern.stop_s[index]);
                for gap in [before, after].into_iter().flatten() {
                    if gap > 0.0 {
                        nearest
                            .entry(*stop)
                            .and_modify(|value| *value = value.min(gap))
                            .or_insert(gap);
                    }
                }
            }
        }
    }
    spacing.sort_by(|a, b| {
        natural_key(&a.label)
            .cmp(&natural_key(&b.label))
            .then(a.dir.cmp(&b.dir))
    });

    #[derive(Default)]
    struct Sum {
        period: StopPeriod,
        bins: [u64; DEVIATION_BINS],
        routes: FxHashSet<u32>,
    }
    let mut by_stop: FxHashMap<u32, Sum> = FxHashMap::default();
    for row in &merged.stop_periods {
        let entry = by_stop.entry(row.stop).or_default();
        entry.period.add(row);
        add_bins(&mut entry.bins, &row.deviation);
        if row.passes > 0 || row.scheduled > 0 {
            entry.routes.insert(row.route);
        }
    }
    let mut stops: Vec<StopRow> = by_stop
        .into_iter()
        .map(|(stop, sum)| {
            let meta = &library.stops[stop as usize];
            let mut routes: Vec<String> = sum
                .routes
                .iter()
                .map(|route| library.routes[*route as usize].label().to_owned())
                .collect();
            routes.sort_by_key(|label| natural_key(label));
            StopRow {
                id: meta.id.clone(),
                code: meta.code.clone(),
                name: meta.name.clone(),
                lat: meta.lat,
                lon: meta.lon,
                routes,
                passes_per_day: sum.period.passes as f32 / days,
                scheduled_per_day: sum.period.scheduled as f32 / days,
                zone_seconds: ratio(
                    f64::from(sum.period.zone_seconds),
                    f64::from(sum.period.zone_count),
                ),
                zone_hours_per_day: sum.period.zone_seconds / 3600.0 / days,
                mean_deviation_s: ratio(
                    sum.period.deviation_sum,
                    sum.bins.iter().sum::<u64>() as f64,
                ),
                on_time: merged.split_deviation(&sum.bins),
                nearest_stop_m: nearest.get(&stop).copied(),
            }
        })
        .collect();
    stops.sort_by(|a, b| b.zone_hours_per_day.total_cmp(&a.zone_hours_per_day));
    StopsReport {
        stops,
        spacing,
        spacing_histogram: histogram,
        spacing_bin_m: HISTOGRAM_BIN,
        close_threshold_m: CLOSE_STOP_M,
    }
}

// ---------------------------------------------------------------------------
// Data quality
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct QualityDay {
    pub date: String,
    pub digest: String,
    pub quality: Quality,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct QualityReport {
    pub days: Vec<QualityDay>,
    pub metric_version: u32,
}

pub fn quality_report(library: &Library, merged: &Merged) -> QualityReport {
    QualityReport {
        days: merged
            .dates
            .iter()
            .map(|date| {
                let day = &library.days[date];
                QualityDay {
                    date: ServiceDate(*date).to_string(),
                    digest: day.digest.clone(),
                    quality: day.quality,
                    warnings: day.warnings.clone(),
                }
            })
            .collect(),
        metric_version: cube::METRIC_VERSION,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::day::process_day;
    use crate::rt::{RawFix, RtBuffer};
    use crate::schedule::fixtures::line_route;
    use crate::time::Clock;

    const THURSDAY: u32 = 20261105;
    const FRIDAY: u32 = 20261106;
    const OFFSET: i32 = -6 * 3600;

    /// Runs one simulated vehicle per entry: `(trip, start seconds, delay, seconds to run the line)`.
    fn analysed_day(library: &mut Library, date: u32, runs: &[(&str, i64, i64, i64)]) {
        let schedule = line_route();
        let clock = Clock::fixed(OFFSET);
        let origin = clock.service_origin(ServiceDate(date)).unwrap();
        let mut buffer = RtBuffer::default();
        for (index, (trip, start, delay, duration)) in runs.iter().enumerate() {
            let vehicle = format!("V{index}");
            let mut t = -60;
            while t <= duration + 120 {
                let progress = (t as f64 / *duration as f64).clamp(0.0, 1.0);
                let epoch = origin + start + delay + t;
                buffer.push(RawFix {
                    fetch: epoch as f64,
                    timestamp: epoch as f64,
                    lat: (43.0 + 0.04 * progress) as f32,
                    lon: -89.0,
                    trip_id: Some(trip.as_bytes()),
                    vehicle_id: Some(vehicle.as_bytes()),
                    route_id: Some(b"R1"),
                    start_date: None,
                    start_time: None,
                    occupancy: -1,
                    differential: false,
                });
                t += 20;
            }
        }
        let result =
            process_day(&schedule, &mut buffer, ServiceDate(date), &clock, i64::MAX).unwrap();
        library.add_schedule(&schedule.meta());
        library.add_day(result.cube, Some(result.events)).unwrap();
    }

    fn selection(dates: &[u32]) -> Selection {
        Selection {
            dates: dates.to_vec(),
            mode: Mode::All,
            early_s: -60,
            late_s: 300,
            periods: Periods::default(),
        }
    }

    #[test]
    fn merging_two_days_adds_sums_and_reports_per_day_rates() {
        let mut library = Library::default();
        analysed_day(&mut library, THURSDAY, &[("T0", 7 * 3600, 0, 1200)]);
        analysed_day(
            &mut library,
            FRIDAY,
            &[("T0", 7 * 3600, 0, 1200), ("T1", 7 * 3600 + 600, 0, 1200)],
        );

        let one = overview(&library, &Merged::compute(&library, selection(&[THURSDAY])));
        let both = overview(
            &library,
            &Merged::compute(&library, selection(&[THURSDAY, FRIDAY])),
        );
        assert_eq!(one.trips_scheduled_per_day, 12.0);
        assert_eq!(
            both.trips_scheduled_per_day, 12.0,
            "an average per day, not a total"
        );
        assert_eq!(both.trips_observed_per_day, 1.5);
        assert_eq!(both.days.len(), 2);
        assert!((one.speed.unwrap() - both.speed.unwrap()).abs() < 0.05);
    }

    #[test]
    fn a_narrower_on_time_window_counts_fewer_trips_as_on_time() {
        let mut library = Library::default();
        analysed_day(&mut library, THURSDAY, &[("T0", 7 * 3600, 240, 1200)]);
        let wide = Merged::compute(&library, selection(&[THURSDAY]));
        let narrow = Merged::compute(
            &library,
            Selection {
                late_s: 180,
                ..selection(&[THURSDAY])
            },
        );
        let wide_result = overview(&library, &wide).on_time;
        let narrow_result = overview(&library, &narrow).on_time;
        assert_eq!(wide_result.total, narrow_result.total);
        assert!(
            wide_result.on_time > 0 && narrow_result.on_time == 0,
            "{wide_result:?} {narrow_result:?}"
        );
        assert_eq!(narrow_result.late, narrow_result.total);
    }

    #[test]
    fn days_not_analysed_are_ignored_rather_than_counted_as_empty() {
        let mut library = Library::default();
        analysed_day(&mut library, THURSDAY, &[("T0", 7 * 3600, 0, 1200)]);
        let merged = Merged::compute(&library, selection(&[THURSDAY, FRIDAY]));
        assert_eq!(merged.dates, vec![THURSDAY]);
        assert_eq!(overview(&library, &merged).trips_scheduled_per_day, 12.0);
    }

    #[test]
    fn a_mode_filter_removes_routes_of_other_modes() {
        let mut library = Library::default();
        analysed_day(&mut library, THURSDAY, &[("T0", 7 * 3600, 0, 1200)]);
        let rail = Merged::compute(
            &library,
            Selection {
                mode: Mode::Rail,
                ..selection(&[THURSDAY])
            },
        );
        assert!(rail.route_hours.is_empty());
        assert_eq!(overview(&library, &rail).speed, None);
        let bus = Merged::compute(
            &library,
            Selection {
                mode: Mode::Bus,
                ..selection(&[THURSDAY])
            },
        );
        assert!(overview(&library, &bus).speed.is_some());
    }

    #[test]
    fn route_score_compares_period_speeds_and_measures_the_peak_penalty() {
        let mut library = Library::default();
        // Slow trips in two "rush" periods, fast ones between them. Trips stay
        // within a few hours of their schedule, as real runs do.
        analysed_day(
            &mut library,
            THURSDAY,
            &[
                ("T0", 7 * 3600, 0, 1800),
                ("T1", 7 * 3600 + 600, 0, 1800),
                ("T2", 7 * 3600 + 1200, 2 * 3600, 900),
                ("T3", 7 * 3600 + 1800, 2 * 3600, 900),
                ("T4", 7 * 3600 + 2400, 3 * 3600, 1800),
                ("T5", 7 * 3600 + 3000, 3 * 3600, 1800),
            ],
        );
        let merged = Merged::compute(
            &library,
            Selection {
                periods: Periods {
                    am: (7, 8),
                    mid: (9, 10),
                    pm: (10, 12),
                },
                ..selection(&[THURSDAY])
            },
        );
        let scores = route_scores(&library, &merged);
        assert_eq!(scores.len(), 1);
        let score = &scores[0];
        let (peak, mid) = (score.speed_peak.unwrap(), score.speed_mid.unwrap());
        assert!((mid / peak - 2.0).abs() < 0.25, "peak {peak} mid {mid}");
        let change = score.peak_change.unwrap();
        assert!((change + 0.5).abs() < 0.08, "change {change}");
        assert!(score.fixed_coverage.unwrap() > 0.5);
        assert!(score.run_p50_s.is_some());
        assert_eq!(score.label, "1");
    }

    #[test]
    fn slow_blocks_surface_as_the_top_delay_hotspot() {
        // Half the line is crawled at rush hour by holding fixes in a narrow range.
        let schedule = line_route();
        let clock = Clock::fixed(OFFSET);
        let origin = clock.service_origin(ServiceDate(THURSDAY)).unwrap();
        let mut buffer = RtBuffer::default();
        let mut push = |vehicle: &str, trip: &str, start: i64, slow: bool| {
            let mut t = 0_i64;
            let mut lat = 43.0_f64;
            while lat < 43.04 {
                let in_slow_zone = slow && (43.02..43.025).contains(&lat);
                let epoch = origin + start + t;
                buffer.push(RawFix {
                    fetch: epoch as f64,
                    timestamp: epoch as f64,
                    lat: lat as f32,
                    lon: -89.0,
                    trip_id: Some(trip.as_bytes()),
                    vehicle_id: Some(vehicle.as_bytes()),
                    route_id: Some(b"R1"),
                    start_date: None,
                    start_time: None,
                    occupancy: -1,
                    differential: false,
                });
                // Slow, but moving: anything slower would be removed as a hold.
                lat += if in_slow_zone { 0.0003 } else { 0.0008 };
                t += 20;
            }
        };
        for i in 0..4 {
            push(&format!("A{i}"), &format!("T{i}"), 7 * 3600 + i * 600, true);
        }
        for i in 4..8 {
            push(
                &format!("B{i}"),
                &format!("T{i}"),
                11 * 3600 + i * 600,
                false,
            );
        }
        for i in 8..12 {
            push(
                &format!("C{i}"),
                &format!("T{i}"),
                5 * 3600 + i * 600,
                false,
            );
        }
        let result = process_day(
            &schedule,
            &mut buffer,
            ServiceDate(THURSDAY),
            &clock,
            i64::MAX,
        )
        .unwrap();
        let mut library = Library::default();
        library.add_schedule(&schedule.meta());
        library.add_day(result.cube, Some(result.events)).unwrap();
        let report = hotspots(&library, &Merged::compute(&library, selection(&[THURSDAY])));
        let top = report.hotspots.first().expect("a hotspot");
        assert!(top.delay_hours_per_day > 0.0);
        assert!(top.worst_speed < top.reference_speed);
        assert_eq!(top.worst_hour, 7);
        // The slow zone sits between stops 2 and 3 (43.02 to 43.025).
        let middle = top.path[top.path.len() / 2][1];
        assert!((43.015..43.03).contains(&middle), "{middle}");
        assert_eq!(top.routes, vec!["1".to_owned()]);
    }

    #[test]
    fn route_detail_orders_the_profile_along_the_line_with_every_stop() {
        let mut library = Library::default();
        analysed_day(&mut library, THURSDAY, &[("T0", 7 * 3600, 0, 1200)]);
        let merged = Merged::compute(&library, selection(&[THURSDAY]));
        let detail = route_detail(&library, &merged, "R1").unwrap();
        let direction = &detail.directions[0];
        assert!(
            direction
                .profile
                .windows(2)
                .all(|w| w[0].s1 <= w[1].s0 + 0.01)
        );
        assert_eq!(direction.stops.len(), 5);
        assert!(direction.stops.windows(2).all(|w| w[0].s <= w[1].s));
        assert!(direction.stops[1].passes >= 1);
        assert!(direction.hourly.iter().any(|h| h.speed.is_some()));
        assert_eq!(direction.run_times.len(), 1);
        assert!(route_detail(&library, &merged, "NOPE").is_none());
    }

    #[test]
    fn string_line_places_each_trip_on_the_distance_axis_with_its_schedule() {
        let mut library = Library::default();
        analysed_day(
            &mut library,
            THURSDAY,
            &[("T0", 7 * 3600, 120, 1200), ("T1", 7 * 3600 + 600, 0, 1200)],
        );
        let merged = Merged::compute(&library, selection(&[THURSDAY]));
        let chart = string_line(&library, &merged, "R1", 0, THURSDAY).unwrap();
        assert_eq!(chart.trips.len(), 2);
        assert_eq!(chart.stops.len(), 5);
        let first = &chart.trips[0];
        assert_eq!(first.trip_id, "T0");
        assert!(
            first
                .observed
                .windows(2)
                .all(|w| w[0].1 <= w[1].1 && w[0].0 <= w[1].0)
        );
        let lateness = first.observed[0].0 - first.scheduled[0].0;
        assert!((lateness - 120).abs() < 30, "{lateness}");
    }

    #[test]
    fn a_stop_visited_twice_keeps_both_places_on_the_string_line() {
        // An out-and-back line serving the same stop in each direction.
        let mut builder = crate::schedule::ScheduleBuilder::new("loop");
        builder.add_route(RouteMeta {
            id: "R".into(),
            short_name: "1".into(),
            long_name: String::new(),
            route_type: Some(3),
            color: String::new(),
            text_color: String::new(),
        });
        for (id, lat) in [("A", 43.0), ("B", 43.02), ("C", 43.04)] {
            builder.add_stop(crate::schedule::StopMeta {
                id: id.into(),
                code: String::new(),
                name: id.into(),
                lat,
                lon: -89.0,
            });
        }
        for (i, lat) in [43.0, 43.02, 43.04, 43.02, 43.0].iter().enumerate() {
            builder.add_shape_point("S", i as i32, *lat, -89.0);
        }
        builder.add_calendar("D", [true; 7], 20260101, 20261231);
        builder.add_trip("T", "R", "D", Some(0), Some("S"), "");
        for (seq, stop, minute) in [
            (1, "A", 0),
            (2, "B", 5),
            (3, "C", 10),
            (4, "B", 15),
            (5, "A", 20),
        ] {
            let time = 7 * 3600 + minute * 60;
            builder.add_stop_time("T", stop, seq, Some(time), Some(time), None);
        }
        let schedule = builder.build().unwrap();

        let clock = Clock::fixed(OFFSET);
        let origin = clock.service_origin(ServiceDate(THURSDAY)).unwrap();
        let mut buffer = RtBuffer::default();
        for step in 0..=62 {
            let fraction = f64::from(step) / 60.0;
            let lat = if fraction <= 0.5 {
                43.0 + 0.08 * fraction
            } else {
                43.08 - 0.08 * fraction
            };
            let epoch = origin + 7 * 3600 + i64::from(step) * 20;
            buffer.push(RawFix {
                fetch: epoch as f64,
                timestamp: epoch as f64,
                lat: lat.max(43.0) as f32,
                lon: -89.0,
                trip_id: Some(b"T"),
                vehicle_id: Some(b"V"),
                route_id: Some(b"R"),
                start_date: None,
                start_time: None,
                occupancy: -1,
                differential: false,
            });
        }
        let result = process_day(
            &schedule,
            &mut buffer,
            ServiceDate(THURSDAY),
            &clock,
            i64::MAX,
        )
        .unwrap();
        let mut library = Library::default();
        library.add_schedule(&schedule.meta());
        library.add_day(result.cube, Some(result.events)).unwrap();
        let merged = Merged::compute(&library, selection(&[THURSDAY]));
        let chart = string_line(&library, &merged, "R", 0, THURSDAY).unwrap();
        let places: Vec<f32> = chart.trips[0]
            .observed
            .iter()
            .map(|point| point.1)
            .collect();
        assert!(places.windows(2).all(|w| w[0] <= w[1]), "{places:?}");
        assert!(places.len() >= 3, "{places:?}");
        // The second pass of stop B sits three quarters of the way along.
        let last = *places.last().unwrap();
        assert!(
            last > chart.length_m * 0.7,
            "{places:?} of {}",
            chart.length_m
        );
    }

    #[test]
    fn stops_report_measures_spacing_and_flags_close_stops() {
        let mut library = Library::default();
        analysed_day(&mut library, THURSDAY, &[("T0", 7 * 3600, 0, 1200)]);
        let report = stops_report(&library, &Merged::compute(&library, selection(&[THURSDAY])));
        assert_eq!(report.spacing.len(), 1);
        let spacing = &report.spacing[0];
        assert!((spacing.mean_m - 1113.2).abs() < 10.0, "{}", spacing.mean_m);
        assert_eq!(spacing.close_share, 0.0);
        assert_eq!(report.stops.len(), 5);
        assert!(report.stops.iter().all(|s| s.nearest_stop_m.is_some()));
        assert_eq!(report.spacing_histogram.iter().sum::<u32>(), 4);
    }

    #[test]
    fn route_intervals_surround_the_figure_shown_beside_them() {
        let mut library = Library::default();
        let dates = [20261102, 20261103, 20261104, 20261105, 20261106];
        for (index, date) in dates.iter().enumerate() {
            let slow = 1500 + index as i64 * 100;
            analysed_day(
                &mut library,
                *date,
                &[
                    ("T0", 7 * 3600, 0, slow),
                    ("T1", 7 * 3600 + 600, 0, slow),
                    ("T2", 7 * 3600 + 1200, 3 * 3600, 900),
                    ("T3", 7 * 3600 + 1800, 3 * 3600, 900),
                ],
            );
        }
        let scores = route_scores(&library, &Merged::compute(&library, selection(&dates)));
        let score = &scores[0];
        let (low, high) = score.peak_ci.expect("five days give an interval");
        let peak = score.speed_peak.unwrap();
        assert!(low <= peak && peak <= high, "{low} {peak} {high}");
        let (low, high) = score.peak_change_ci.expect("five days give an interval");
        let change = score.peak_change.unwrap();
        assert!(low <= change && change <= high, "{low} {change} {high}");
    }

    #[test]
    fn the_network_map_pools_routes_and_reports_only_cells_with_enough_data() {
        let mut library = Library::default();
        analysed_day(&mut library, THURSDAY, &[("T0", 7 * 3600, 0, 1200)]);
        let merged = Merged::compute(&library, selection(&[THURSDAY]));
        let map = network_map(&library, &merged, None);
        assert!(
            map.features
                .iter()
                .all(|f| f.measurements >= MIN_CELL_PAIRS)
        );
        assert!(map.hours.iter().any(|h| h.hour == 7));
        assert!(map.bounds.is_some());
        let filtered = network_map(&library, &merged, Some("R1"));
        assert_eq!(filtered.features.len(), map.features.len());
        let none = network_map(&library, &merged, Some("MISSING"));
        assert_eq!(
            none.features.len(),
            map.features.len(),
            "an unknown route doesn't blank the map"
        );
    }

    #[test]
    fn bootstrap_interval_contains_the_estimate_and_is_reproducible() {
        let mut library = Library::default();
        let dates = [20261102, 20261103, 20261104, 20261105, 20261106];
        for (index, date) in dates.iter().enumerate() {
            let duration = 1100 + index as i64 * 100;
            analysed_day(
                &mut library,
                *date,
                &[
                    ("T0", 7 * 3600, 0, duration),
                    ("T1", 16 * 3600, 0, duration),
                ],
            );
        }
        let merged = Merged::compute(&library, selection(&dates));
        let (first, _) = bootstrap_peak(&library, &merged, 0);
        let (second, _) = bootstrap_peak(&library, &merged, 0);
        assert_eq!(first, second);
        let (low, high) = first.unwrap();
        let estimate = overview(&library, &merged).speed_peak.unwrap();
        assert!(
            low <= estimate && estimate <= high,
            "{low} {estimate} {high}"
        );
        assert!(high > low);
    }
}
