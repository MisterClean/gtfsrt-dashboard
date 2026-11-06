//! The static schedule, compiled into the shapes analytics needs.
//!
//! Trips sharing a shape and stop list collapse into one [`Pattern`], so stop
//! positions are solved once per pattern. Route lines are cut into directional
//! street segments ([`SegKey`]) defined by a geographic grid rather than by
//! shape IDs, which lets results merge across schedule versions.

use crate::geo::{Polyline, assign_stop_positions, remove_spikes};
use crate::time::ServiceDate;
use chrono::Weekday;
use rustc_hash::{FxHashMap, FxHashSet};
use serde::{Deserialize, Serialize};

/// Nominal size of a street segment. Matches the roughly 220 m cells used by
/// the CTA scorecard closely enough to keep the same reading of the map.
pub const CELL_METERS: f64 = 200.0;

/// Runs shorter than this merge into the neighbouring segment, so a shape that
/// clips the corner of a cell doesn't create a sliver with almost no data.
const MIN_BIN_METERS: f32 = 40.0;

const BEARING_SECTORS: f32 = 8.0;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct RouteMeta {
    pub id: String,
    pub short_name: String,
    pub long_name: String,
    pub route_type: Option<i32>,
    pub color: String,
    pub text_color: String,
}

impl RouteMeta {
    /// The label a rider would recognise.
    pub fn label(&self) -> &str {
        [&self.short_name, &self.long_name, &self.id]
            .into_iter()
            .find(|s| !s.is_empty())
            .map_or("", String::as_str)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct StopMeta {
    pub id: String,
    pub code: String,
    pub name: String,
    pub lat: f64,
    pub lon: f64,
}

/// A directional street segment: one route, one direction, one grid cell and
/// one compass sector. Stable across schedule versions.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct SegKey {
    pub route: u32,
    pub dir: u8,
    pub x: i32,
    pub y: i32,
    pub sector: u8,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct SegMeta {
    pub key: SegKey,
    pub length_m: f32,
    /// The drawn line as `[lon, lat]` pairs.
    pub path: Vec<[f32; 2]>,
}

/// A slice of a pattern falling inside one segment.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
pub struct Bin {
    pub s0: f32,
    pub s1: f32,
    pub seg: u32,
}

/// One distinct way of running a route: a shape plus an ordered stop list.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Pattern {
    pub route: u32,
    pub dir: u8,
    pub shape_id: String,
    pub headsign: String,
    pub stops: Vec<u32>,
    pub stop_s: Vec<f32>,
    pub length_m: f32,
    pub trip_count: u32,
    pub synthetic_shape: bool,
    pub bins: Vec<Bin>,
    /// Simplified line as `[lon, lat]` pairs, for drawing the route.
    pub path: Vec<[f32; 2]>,
}

/// One scheduled trip. Its times live in the schedule's flat arrays starting at
/// `times_start`, one entry per pattern stop.
#[derive(Clone, Debug)]
pub struct Trip {
    pub id: String,
    pub route: u32,
    pub service: u32,
    pub pattern: u32,
    pub times_start: u32,
    pub has_timepoints: bool,
}

#[derive(Clone, Debug, Default)]
struct Service {
    weekdays: [bool; 7],
    start: u32,
    end: u32,
    has_calendar: bool,
    added: FxHashSet<u32>,
    removed: FxHashSet<u32>,
}

impl Service {
    fn active(&self, date: ServiceDate) -> bool {
        if self.removed.contains(&date.0) {
            return false;
        }
        if self.added.contains(&date.0) {
            return true;
        }
        if !self.has_calendar || date.0 < self.start || date.0 > self.end {
            return false;
        }
        date.weekday()
            .is_some_and(|day| self.weekdays[day.num_days_from_monday() as usize])
    }
}

/// The geographic grid. The longitude step is derived from a whole-degree
/// latitude, so every schedule version of an agency lands on the same cells.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
pub struct Grid {
    pub lat_step: f64,
    pub lon_step: f64,
}

impl Grid {
    pub fn for_latitude(latitude: f64) -> Self {
        let lat_step = CELL_METERS / 111_320.0;
        let cos_lat = latitude.round().to_radians().cos().abs().max(0.05);
        Self {
            lat_step,
            lon_step: lat_step / cos_lat,
        }
    }

    pub fn cell(&self, lat: f64, lon: f64) -> (i32, i32) {
        (
            (lon / self.lon_step).floor() as i32,
            (lat / self.lat_step).floor() as i32,
        )
    }
}

/// A schedule compiled for analysis.
#[derive(Clone, Debug)]
pub struct Schedule {
    pub digest: String,
    pub timezone: Option<String>,
    pub routes: Vec<RouteMeta>,
    pub stops: Vec<StopMeta>,
    pub trips: Vec<Trip>,
    pub patterns: Vec<Pattern>,
    pub polylines: Vec<Polyline>,
    pub pattern_line: Vec<u32>,
    pub segs: Vec<SegMeta>,
    pub grid: Grid,
    pub center: (f64, f64),
    pub arrivals: Vec<i32>,
    pub departures: Vec<i32>,
    pub timepoints: Vec<bool>,
    pub trip_lookup: FxHashMap<String, u32>,
    pub warnings: Vec<String>,
    services: Vec<Service>,
}

impl Schedule {
    pub fn service_active(&self, trip: &Trip, date: ServiceDate) -> bool {
        self.services
            .get(trip.service as usize)
            .is_some_and(|service| service.active(date))
    }

    /// Scheduled `(arrival, departure)` at each pattern stop for a trip.
    pub fn trip_times(&self, trip: &Trip) -> (&[i32], &[i32]) {
        let start = trip.times_start as usize;
        let count = self.patterns[trip.pattern as usize].stops.len();
        (
            &self.arrivals[start..start + count],
            &self.departures[start..start + count],
        )
    }

    pub fn trip_timepoints(&self, trip: &Trip) -> &[bool] {
        let start = trip.times_start as usize;
        let count = self.patterns[trip.pattern as usize].stops.len();
        &self.timepoints[start..start + count]
    }

    /// The serializable part of the schedule that reports need after the raw
    /// tables are gone, including when a day is reloaded from the local cache.
    pub fn meta(&self) -> ScheduleMeta {
        ScheduleMeta {
            digest: self.digest.clone(),
            timezone: self.timezone.clone(),
            center: self.center,
            routes: self.routes.clone(),
            stops: self.stops.clone(),
            segs: self.segs.clone(),
            patterns: self.patterns.clone(),
        }
    }
}

/// See [`Schedule::meta`].
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ScheduleMeta {
    pub digest: String,
    pub timezone: Option<String>,
    pub center: (f64, f64),
    pub routes: Vec<RouteMeta>,
    pub stops: Vec<StopMeta>,
    pub segs: Vec<SegMeta>,
    pub patterns: Vec<Pattern>,
}

/// Parses a GTFS clock time. Hours can exceed 24 for overnight service.
pub fn parse_gtfs_time(value: &str) -> Option<i32> {
    let mut parts = value.trim().split(':');
    let hours: i32 = parts.next()?.parse().ok()?;
    let minutes: i32 = parts.next()?.parse().ok()?;
    let seconds: i32 = parts.next().map_or(Some(0), |s| s.parse().ok())?;
    let valid = (0..60).contains(&minutes) && (0..60).contains(&seconds) && hours >= 0;
    valid.then_some(hours * 3600 + minutes * 60 + seconds)
}

#[derive(Default)]
struct RawTrip {
    id: String,
    route: u32,
    service: u32,
    direction: u8,
    shape: Option<u32>,
    headsign: String,
}

const TIME_UNKNOWN: i32 = i32::MIN;

/// Accumulates GTFS rows, which may arrive in any batch order, from one or more
/// schedule sources. The first definition of a repeated ID wins.
#[derive(Default)]
pub struct ScheduleBuilder {
    digest: String,
    timezone: Option<String>,
    routes: Vec<RouteMeta>,
    route_ids: FxHashMap<String, u32>,
    stops: Vec<StopMeta>,
    stop_ids: FxHashMap<String, u32>,
    shape_ids: FxHashMap<String, u32>,
    shape_names: Vec<String>,
    shape_points: Vec<Vec<(i32, f64, f64)>>,
    trips: Vec<RawTrip>,
    trip_ids: FxHashMap<String, u32>,
    services: Vec<Service>,
    service_ids: FxHashMap<String, u32>,
    stop_time_rows: Vec<StopTimeRow>,
    warnings: Vec<String>,
}

#[derive(Clone, Copy)]
struct StopTimeRow {
    trip: u32,
    stop: u32,
    sequence: i32,
    arrival: i32,
    departure: i32,
    timepoint: Option<bool>,
}

impl ScheduleBuilder {
    pub fn new(digest: impl Into<String>) -> Self {
        Self {
            digest: digest.into(),
            ..Self::default()
        }
    }

    pub fn set_timezone(&mut self, timezone: &str) {
        if self.timezone.is_none() && !timezone.is_empty() {
            self.timezone = Some(timezone.to_owned());
        }
    }

    pub fn add_route(&mut self, route: RouteMeta) {
        if !self.route_ids.contains_key(&route.id) {
            self.route_ids
                .insert(route.id.clone(), self.routes.len() as u32);
            self.routes.push(route);
        }
    }

    pub fn add_stop(&mut self, stop: StopMeta) {
        if !self.stop_ids.contains_key(&stop.id) {
            self.stop_ids
                .insert(stop.id.clone(), self.stops.len() as u32);
            self.stops.push(stop);
        }
    }

    pub fn add_shape_point(&mut self, shape_id: &str, sequence: i32, lat: f64, lon: f64) {
        let index = match self.shape_ids.get(shape_id) {
            Some(index) => *index,
            None => {
                let index = self.shape_names.len() as u32;
                self.shape_ids.insert(shape_id.to_owned(), index);
                self.shape_names.push(shape_id.to_owned());
                self.shape_points.push(Vec::new());
                index
            }
        };
        self.shape_points[index as usize].push((sequence, lat, lon));
    }

    fn service_index(&mut self, service_id: &str) -> u32 {
        if let Some(index) = self.service_ids.get(service_id) {
            return *index;
        }
        let index = self.services.len() as u32;
        self.service_ids.insert(service_id.to_owned(), index);
        self.services.push(Service::default());
        index
    }

    pub fn add_calendar(&mut self, service_id: &str, weekdays: [bool; 7], start: u32, end: u32) {
        let index = self.service_index(service_id) as usize;
        let service = &mut self.services[index];
        service.weekdays = weekdays;
        service.start = start;
        service.end = end;
        service.has_calendar = true;
    }

    /// `exception_type` follows GTFS: 1 adds service, 2 removes it.
    pub fn add_calendar_date(&mut self, service_id: &str, date: u32, exception_type: i32) {
        let index = self.service_index(service_id) as usize;
        let service = &mut self.services[index];
        match exception_type {
            1 => {
                service.added.insert(date);
            }
            2 => {
                service.removed.insert(date);
            }
            _ => {}
        }
    }

    pub fn add_trip(
        &mut self,
        trip_id: &str,
        route_id: &str,
        service_id: &str,
        direction: Option<u8>,
        shape_id: Option<&str>,
        headsign: &str,
    ) {
        if self.trip_ids.contains_key(trip_id) {
            return;
        }
        let Some(route) = self.route_ids.get(route_id).copied() else {
            return;
        };
        let service = self.service_index(service_id);
        let shape = shape_id.and_then(|id| self.shape_ids.get(id).copied());
        self.trip_ids
            .insert(trip_id.to_owned(), self.trips.len() as u32);
        self.trips.push(RawTrip {
            id: trip_id.to_owned(),
            route,
            service,
            direction: direction.unwrap_or(2),
            shape,
            headsign: headsign.to_owned(),
        });
    }

    pub fn add_stop_time(
        &mut self,
        trip_id: &str,
        stop_id: &str,
        sequence: i32,
        arrival: Option<i32>,
        departure: Option<i32>,
        timepoint: Option<bool>,
    ) {
        let (Some(trip), Some(stop)) = (
            self.trip_ids.get(trip_id).copied(),
            self.stop_ids.get(stop_id).copied(),
        ) else {
            return;
        };
        self.stop_time_rows.push(StopTimeRow {
            trip,
            stop,
            sequence,
            arrival: arrival.or(departure).unwrap_or(TIME_UNKNOWN),
            departure: departure.or(arrival).unwrap_or(TIME_UNKNOWN),
            timepoint,
        });
    }

    /// Compiles everything added so far.
    pub fn build(mut self) -> Result<Schedule, String> {
        if self.trips.is_empty() || self.stop_time_rows.is_empty() {
            return Err("The schedule has no usable trips or stop times.".to_owned());
        }
        self.stop_time_rows
            .sort_unstable_by_key(|row| (row.trip, row.sequence));
        self.stop_time_rows
            .dedup_by_key(|row| (row.trip, row.sequence));

        let center = stop_center(&self.stops);
        let grid = Grid::for_latitude(center.0);

        let mut lines: Vec<Option<Polyline>> = Vec::with_capacity(self.shape_points.len());
        for points in &mut self.shape_points {
            points.sort_unstable_by_key(|p| p.0);
            let latlon: Vec<(f64, f64)> = points.iter().map(|p| (p.1, p.2)).collect();
            lines.push(Polyline::from_lat_lon(&remove_spikes(&latlon)));
        }

        let mut compiler = PatternCompiler::new(&self.stops, grid, &lines, &self.shape_names);
        let mut trips = Vec::with_capacity(self.trips.len());
        let mut arrivals = Vec::with_capacity(self.stop_time_rows.len());
        let mut departures = Vec::with_capacity(self.stop_time_rows.len());
        let mut timepoints = Vec::with_capacity(self.stop_time_rows.len());
        let mut trip_lookup = FxHashMap::default();
        let mut dropped = 0_usize;

        let mut start = 0;
        while start < self.stop_time_rows.len() {
            let trip_index = self.stop_time_rows[start].trip;
            let end =
                start + self.stop_time_rows[start..].partition_point(|row| row.trip == trip_index);
            let rows = &self.stop_time_rows[start..end];
            start = end;
            let raw = &self.trips[trip_index as usize];
            let Some(pattern) = compiler.pattern_for(raw, rows) else {
                dropped += 1;
                continue;
            };
            let times_start = arrivals.len() as u32;
            let positions = &compiler.patterns[pattern as usize].stop_s;
            let (mut arrival, mut departure): (Vec<i32>, Vec<i32>) =
                rows.iter().map(|row| (row.arrival, row.departure)).unzip();
            if !interpolate_times(&mut arrival, &mut departure, positions) {
                dropped += 1;
                continue;
            }
            let any_flag = rows.iter().any(|row| row.timepoint == Some(true));
            arrivals.extend(arrival);
            departures.extend(departure);
            timepoints.extend(rows.iter().map(|row| row.timepoint == Some(true)));
            trip_lookup.insert(raw.id.clone(), trips.len() as u32);
            trips.push(Trip {
                id: raw.id.clone(),
                route: raw.route,
                service: raw.service,
                pattern,
                times_start,
                has_timepoints: any_flag,
            });
            compiler.patterns[pattern as usize].trip_count += 1;
        }
        if dropped > 0 {
            self.warnings.push(format!(
                "{dropped} scheduled trips have no usable geometry or times and were left out."
            ));
        }
        if trips.is_empty() {
            return Err("No scheduled trip could be placed on a route shape.".to_owned());
        }
        let PatternCompiler {
            patterns,
            polylines,
            pattern_line,
            segs,
            ..
        } = compiler;
        Ok(Schedule {
            digest: self.digest,
            timezone: self.timezone,
            routes: self.routes,
            stops: self.stops,
            trips,
            patterns,
            polylines,
            pattern_line,
            segs,
            grid,
            center,
            arrivals,
            departures,
            timepoints,
            trip_lookup,
            warnings: self.warnings,
            services: self.services,
        })
    }
}

fn stop_center(stops: &[StopMeta]) -> (f64, f64) {
    let valid: Vec<&StopMeta> = stops
        .iter()
        .filter(|s| crate::geo::valid_coordinate(s.lat, s.lon))
        .collect();
    if valid.is_empty() {
        return (0.0, 0.0);
    }
    let count = valid.len() as f64;
    (
        valid.iter().map(|s| s.lat).sum::<f64>() / count,
        valid.iter().map(|s| s.lon).sum::<f64>() / count,
    )
}

/// Fills blank times in by distance along the line. Returns `false` when the
/// trip has no anchor time to interpolate from.
fn interpolate_times(arrival: &mut [i32], departure: &mut [i32], positions: &[f32]) -> bool {
    let known: Vec<usize> = (0..arrival.len())
        .filter(|i| departure[*i] != TIME_UNKNOWN)
        .collect();
    let (Some(&first), Some(&last)) = (known.first(), known.last()) else {
        return false;
    };
    for i in 0..first {
        arrival[i] = arrival[first];
        departure[i] = arrival[first];
    }
    for i in last + 1..arrival.len() {
        arrival[i] = departure[last];
        departure[i] = departure[last];
    }
    for pair in known.windows(2) {
        let (a, b) = (pair[0], pair[1]);
        let span = (positions[b] - positions[a]).max(0.0);
        for i in a + 1..b {
            let fraction = if span > 0.0 {
                (positions[i] - positions[a]) / span
            } else {
                (i - a) as f32 / (b - a) as f32
            };
            let value =
                departure[a] + ((arrival[b] - departure[a]) as f32 * fraction).round() as i32;
            arrival[i] = value;
            departure[i] = value;
        }
    }
    true
}

struct PatternCompiler<'a> {
    stops: &'a [StopMeta],
    grid: Grid,
    lines: &'a [Option<Polyline>],
    shape_names: &'a [String],
    pattern_ids: FxHashMap<(Option<u32>, u32, u8, Vec<u32>), u32>,
    bin_cache: FxHashMap<(u32, u32, u8), Vec<Bin>>,
    seg_ids: FxHashMap<SegKey, u32>,
    patterns: Vec<Pattern>,
    polylines: Vec<Polyline>,
    line_ids: FxHashMap<u32, u32>,
    pattern_line: Vec<u32>,
    segs: Vec<SegMeta>,
}

impl<'a> PatternCompiler<'a> {
    fn new(
        stops: &'a [StopMeta],
        grid: Grid,
        lines: &'a [Option<Polyline>],
        shape_names: &'a [String],
    ) -> Self {
        Self {
            stops,
            grid,
            lines,
            shape_names,
            pattern_ids: FxHashMap::default(),
            bin_cache: FxHashMap::default(),
            seg_ids: FxHashMap::default(),
            patterns: Vec::new(),
            polylines: Vec::new(),
            line_ids: FxHashMap::default(),
            pattern_line: Vec::new(),
            segs: Vec::new(),
        }
    }

    fn pattern_for(&mut self, trip: &RawTrip, rows: &[StopTimeRow]) -> Option<u32> {
        if rows.len() < 2 {
            return None;
        }
        let stop_list: Vec<u32> = rows.iter().map(|row| row.stop).collect();
        let shape = trip
            .shape
            .filter(|shape| self.lines.get(*shape as usize).is_some_and(Option::is_some));
        let key = (shape, trip.route, trip.direction, stop_list);
        if let Some(index) = self.pattern_ids.get(&key) {
            return Some(*index);
        }
        let (shape_key, route, direction, stop_list) = key.clone();

        // A trip without a shape gets a straight-line path through its stops.
        let (line_index, synthetic) = match shape_key {
            Some(shape) => (self.intern_line(shape), false),
            None => {
                let points: Vec<(f64, f64)> = stop_list
                    .iter()
                    .map(|stop| {
                        let stop = &self.stops[*stop as usize];
                        (stop.lat, stop.lon)
                    })
                    .collect();
                let line = Polyline::from_lat_lon(&points)?;
                self.polylines.push(line);
                ((self.polylines.len() - 1) as u32, true)
            }
        };
        let line = &self.polylines[line_index as usize];
        let stop_xy: Vec<[f32; 2]> = stop_list
            .iter()
            .map(|stop| {
                let stop = &self.stops[*stop as usize];
                line.frame.to_xy(stop.lat, stop.lon)
            })
            .collect();
        let stop_s = assign_stop_positions(line, &stop_xy);
        let length_m = line.length();
        let path = simplify_path(line);
        let bins = self.bins_for(line_index, route, direction);
        let shape_id = shape_key
            .and_then(|shape| self.shape_names.get(shape as usize).cloned())
            .unwrap_or_default();

        let index = self.patterns.len() as u32;
        self.patterns.push(Pattern {
            route,
            dir: direction,
            shape_id,
            headsign: trip.headsign.clone(),
            stops: stop_list,
            stop_s,
            length_m,
            trip_count: 0,
            synthetic_shape: synthetic,
            bins,
            path,
        });
        self.pattern_line.push(line_index);
        self.pattern_ids.insert(key, index);
        Some(index)
    }

    fn intern_line(&mut self, shape: u32) -> u32 {
        if let Some(index) = self.line_ids.get(&shape) {
            return *index;
        }
        let line = self.lines[shape as usize]
            .clone()
            .expect("pattern_for only passes shapes whose line exists");
        let index = self.polylines.len() as u32;
        self.polylines.push(line);
        self.line_ids.insert(shape, index);
        index
    }

    /// Cuts a line into segments for one route and direction. Bins are shared
    /// by every pattern on the same line, route and direction.
    fn bins_for(&mut self, line_index: u32, route: u32, direction: u8) -> Vec<Bin> {
        if let Some(bins) = self.bin_cache.get(&(line_index, route, direction)) {
            return bins.clone();
        }
        let line = self.polylines[line_index as usize].clone();
        let (length, step) = (line.length(), 20.0_f32);
        let mut bins: Vec<Bin> = Vec::new();
        let mut run_start = 0.0_f32;
        let mut run_key: Option<SegKey> = None;
        let mut s = 0.0_f32;
        while s <= length {
            let key = self.seg_key(&line, s, route, direction);
            if run_key != Some(key) {
                if let Some(previous) = run_key {
                    self.push_bin(&line, &mut bins, previous, run_start, s);
                }
                run_key = Some(key);
                run_start = s;
            }
            s += step;
        }
        if let Some(previous) = run_key {
            self.push_bin(&line, &mut bins, previous, run_start, length);
        }
        self.bin_cache
            .insert((line_index, route, direction), bins.clone());
        bins
    }

    fn seg_key(&self, line: &Polyline, s: f32, route: u32, dir: u8) -> SegKey {
        let (lat, lon) = line.frame.to_lat_lon(line.point_at(s));
        let (x, y) = self.grid.cell(lat, lon);
        let sector_width = 360.0 / BEARING_SECTORS;
        let sector = ((line.bearing_at(s) + sector_width / 2.0) / sector_width).floor() as u32
            % BEARING_SECTORS as u32;
        SegKey {
            route,
            dir,
            x,
            y,
            sector: sector as u8,
        }
    }

    fn push_bin(&mut self, line: &Polyline, bins: &mut Vec<Bin>, key: SegKey, s0: f32, s1: f32) {
        let span = s1 - s0;
        if span <= 0.0 {
            return;
        }
        // Slivers extend the previous bin rather than creating a new segment.
        if span < MIN_BIN_METERS
            && let Some(previous) = bins.last_mut()
        {
            previous.s1 = s1;
            self.extend_seg(line, previous.seg, s0, s1);
            return;
        }
        let seg = match self.seg_ids.get(&key).copied() {
            Some(seg) => {
                self.extend_seg(line, seg, s0, s1);
                seg
            }
            None => {
                let seg = self.segs.len() as u32;
                self.seg_ids.insert(key, seg);
                self.segs.push(SegMeta {
                    key,
                    length_m: span,
                    path: path_between(line, s0, s1),
                });
                seg
            }
        };
        bins.push(Bin { s0, s1, seg });
    }

    /// Keeps the longest slice seen for a segment as its drawn line and length.
    fn extend_seg(&mut self, line: &Polyline, seg: u32, s0: f32, s1: f32) {
        let span = s1 - s0;
        let meta = &mut self.segs[seg as usize];
        if span > meta.length_m {
            meta.length_m = span;
            meta.path = path_between(line, s0, s1);
        }
    }
}

fn path_between(line: &Polyline, s0: f32, s1: f32) -> Vec<[f32; 2]> {
    let mut points = vec![line.point_at(s0)];
    let first = line.cum.partition_point(|c| *c <= s0);
    let last = line.cum.partition_point(|c| *c < s1);
    points.extend(line.xy.iter().take(last).skip(first).copied());
    points.push(line.point_at(s1));
    points
        .into_iter()
        .map(|xy| {
            let (lat, lon) = line.frame.to_lat_lon(xy);
            [lon as f32, lat as f32]
        })
        .collect()
}

/// Thins a route line for drawing with Douglas-Peucker at about 8 m.
fn simplify_path(line: &Polyline) -> Vec<[f32; 2]> {
    const TOLERANCE: f32 = 8.0;
    let count = line.xy.len();
    let mut keep = vec![false; count];
    keep[0] = true;
    keep[count - 1] = true;
    let mut stack = vec![(0, count - 1)];
    while let Some((a, b)) = stack.pop() {
        if b <= a + 1 {
            continue;
        }
        let (pa, pb) = (line.xy[a], line.xy[b]);
        let (dx, dy) = (pb[0] - pa[0], pb[1] - pa[1]);
        let length = (dx * dx + dy * dy).sqrt().max(0.001);
        let mut farthest = (a, 0.0_f32);
        for i in a + 1..b {
            let p = line.xy[i];
            let offset = ((p[0] - pa[0]) * dy - (p[1] - pa[1]) * dx).abs() / length;
            if offset > farthest.1 {
                farthest = (i, offset);
            }
        }
        if farthest.1 > TOLERANCE {
            keep[farthest.0] = true;
            stack.push((a, farthest.0));
            stack.push((farthest.0, b));
        }
    }
    line.xy
        .iter()
        .zip(&keep)
        .filter(|(_, k)| **k)
        .map(|(xy, _)| {
            let (lat, lon) = line.frame.to_lat_lon(*xy);
            [lon as f32, lat as f32]
        })
        .collect()
}

/// Converts `weekday` flags in Monday-first order for [`ScheduleBuilder::add_calendar`].
pub fn weekday_flags(flags: impl Fn(Weekday) -> bool) -> [bool; 7] {
    [
        Weekday::Mon,
        Weekday::Tue,
        Weekday::Wed,
        Weekday::Thu,
        Weekday::Fri,
        Weekday::Sat,
        Weekday::Sun,
    ]
    .map(flags)
}

#[cfg(test)]
pub(crate) mod fixtures {
    use super::*;

    /// One straight north-south route of about 4.4 km with five stops, one
    /// weekday trip every ten minutes between 07:00 and 09:00, and a timepoint at
    /// each end. Stops sit roughly 1.1 km apart.
    pub fn line_route() -> Schedule {
        let mut builder = ScheduleBuilder::new("v1:test");
        builder.set_timezone("America/Chicago");
        builder.add_route(RouteMeta {
            id: "R1".into(),
            short_name: "1".into(),
            long_name: "Main Street".into(),
            route_type: Some(3),
            color: "AA0000".into(),
            text_color: "FFFFFF".into(),
        });
        let lat = |i: usize| 43.0 + 0.01 * i as f64;
        for i in 0..5 {
            builder.add_stop(StopMeta {
                id: format!("S{i}"),
                code: String::new(),
                name: format!("Stop {i}"),
                lat: lat(i),
                lon: -89.0,
            });
        }
        for i in 0..=8 {
            builder.add_shape_point("SH1", i, 43.0 + 0.005 * f64::from(i), -89.0);
        }
        builder.add_calendar(
            "WK",
            weekday_flags(|d| !matches!(d, Weekday::Sat | Weekday::Sun)),
            20260101,
            20261231,
        );
        for trip in 0..12 {
            let id = format!("T{trip}");
            builder.add_trip(&id, "R1", "WK", Some(0), Some("SH1"), "Northbound");
            let start = 7 * 3600 + trip * 600;
            for stop in 0..5 {
                let time = start + stop * 300;
                builder.add_stop_time(
                    &id,
                    &format!("S{stop}"),
                    stop,
                    Some(time),
                    Some(time),
                    Some(stop == 0 || stop == 4),
                );
            }
        }
        builder.build().unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_overnight_times_and_rejects_invalid_ones() {
        assert_eq!(parse_gtfs_time("25:10:05"), Some(25 * 3600 + 10 * 60 + 5));
        assert_eq!(parse_gtfs_time(" 7:05:00"), Some(7 * 3600 + 5 * 60));
        assert_eq!(parse_gtfs_time("07:65:00"), None);
        assert_eq!(parse_gtfs_time(""), None);
    }

    #[test]
    fn compiles_trips_into_one_pattern_with_ordered_stop_positions() {
        let schedule = fixtures::line_route();
        assert_eq!(schedule.patterns.len(), 1);
        assert_eq!(schedule.trips.len(), 12);
        let pattern = &schedule.patterns[0];
        assert_eq!(pattern.trip_count, 12);
        assert!(pattern.stop_s.windows(2).all(|w| w[0] < w[1]));
        assert!(
            (pattern.stop_s[1] - 1113.2).abs() < 5.0,
            "{:?}",
            pattern.stop_s
        );
    }

    #[test]
    fn bins_cover_the_whole_line_contiguously_and_reference_real_segments() {
        let schedule = fixtures::line_route();
        let pattern = &schedule.patterns[0];
        assert_eq!(pattern.bins.first().unwrap().s0, 0.0);
        assert!((pattern.bins.last().unwrap().s1 - pattern.length_m).abs() < 0.01);
        assert!(
            pattern
                .bins
                .windows(2)
                .all(|w| (w[0].s1 - w[1].s0).abs() < 0.01)
        );
        assert!(
            pattern
                .bins
                .iter()
                .all(|b| (b.seg as usize) < schedule.segs.len())
        );
        // 4.4 km at a 200 m grid.
        assert!(
            (18..=26).contains(&pattern.bins.len()),
            "{}",
            pattern.bins.len()
        );
    }

    #[test]
    fn segment_keys_do_not_depend_on_schedule_contents() {
        // Regenerating the schedule must yield identical keys.
        let a = fixtures::line_route();
        let b = fixtures::line_route();
        assert_eq!(a.segs[3].key, b.segs[3].key);
        assert_eq!(a.grid, Grid::for_latitude(43.3));
    }

    #[test]
    fn calendar_exceptions_override_the_weekly_pattern() {
        let mut builder = ScheduleBuilder::new("x");
        builder.add_calendar(
            "A",
            weekday_flags(|d| d == Weekday::Mon),
            20261101,
            20261130,
        );
        builder.add_calendar_date("A", 20261103, 1);
        builder.add_calendar_date("A", 20261102, 2);
        let service = &builder.services[0];
        assert!(!service.active(ServiceDate(20261102)), "a removed Monday");
        assert!(service.active(ServiceDate(20261103)), "an added Tuesday");
        assert!(service.active(ServiceDate(20261109)), "an ordinary Monday");
        assert!(!service.active(ServiceDate(20261207)), "past the end date");
    }

    #[test]
    fn blank_stop_times_interpolate_by_distance() {
        let mut arrival = vec![100, TIME_UNKNOWN, 300];
        let mut departure = vec![100, TIME_UNKNOWN, 300];
        assert!(interpolate_times(
            &mut arrival,
            &mut departure,
            &[0.0, 500.0, 2000.0]
        ));
        assert_eq!(arrival[1], 150);
        let mut none = vec![TIME_UNKNOWN];
        let mut none_d = vec![TIME_UNKNOWN];
        assert!(!interpolate_times(&mut none, &mut none_d, &[0.0]));
    }

    #[test]
    fn empty_schedule_is_an_error_not_a_panic() {
        assert!(ScheduleBuilder::new("x").build().is_err());
    }
}
