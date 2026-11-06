//! Additive rollups for one service day.
//!
//! Every field is a sum or a count, so any set of days merges by addition with
//! no loss. That is what makes filtering instant and lets a day be cached once
//! and reused. Rates are only ever computed from the merged sums.

use crate::schedule::ScheduleMeta;
use crate::time::{SERVICE_HOURS, ServiceDate};
use serde::{Deserialize, Serialize};

/// Bumped whenever a calculation changes, which invalidates cached days.
pub const METRIC_VERSION: u32 = 1;

/// Upper edges in seconds of the schedule-deviation bins. Reports can apply any
/// on-time window whose edges fall on these boundaries.
pub const DEVIATION_EDGES: [i32; 11] = [-300, -180, -60, 0, 60, 120, 180, 300, 600, 900, 1200];
pub const DEVIATION_BINS: usize = DEVIATION_EDGES.len() + 1;

pub fn deviation_bin(seconds: i32) -> usize {
    DEVIATION_EDGES.partition_point(|edge| *edge <= seconds)
}

/// Time-of-day groups for stop-level rollups. Route-level data stays hourly.
pub const STOP_PERIODS: usize = 5;

pub fn stop_period(hour: usize) -> usize {
    match hour {
        0..=6 => 0,
        7..=8 => 1,
        9..=15 => 2,
        16..=17 => 3,
        _ => 4,
    }
}

/// Observed headway sums for frequent service: stops and times where the
/// schedule itself runs 15 minutes apart or better. At lower frequencies riders
/// time their arrival, so schedule adherence is the meaningful measure instead.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Headways {
    pub count: u32,
    pub sum: f64,
    pub sum_squares: f64,
    /// Less than a quarter of the scheduled headway.
    pub bunched: u32,
    /// More than one and a half times the scheduled headway.
    pub gapped: u32,
    /// No more than three minutes over the scheduled headway.
    pub wait_ok: u32,
}

/// Service counts as frequent at or below this scheduled headway.
pub const FREQUENT_HEADWAY_S: f64 = 900.0;

impl Headways {
    pub fn add(&mut self, other: &Self) {
        self.count += other.count;
        self.sum += other.sum;
        self.sum_squares += other.sum_squares;
        self.bunched += other.bunched;
        self.gapped += other.gapped;
        self.wait_ok += other.wait_ok;
    }

    pub fn record(&mut self, observed: f64, scheduled: f64) {
        self.count += 1;
        self.sum += observed;
        self.sum_squares += observed * observed;
        if observed < 0.25 * scheduled {
            self.bunched += 1;
        }
        if observed > 1.5 * scheduled {
            self.gapped += 1;
        }
        if observed <= scheduled + 180.0 {
            self.wait_ok += 1;
        }
    }
}

/// One route, direction and service hour.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct RouteHour {
    pub route: u32,
    pub dir: u8,
    pub hour: u8,
    pub meters: f64,
    pub seconds: f64,
    pub stopped_seconds: f64,
    pub sched_meters: f64,
    pub sched_seconds: f64,
    pub trips_scheduled: u32,
    pub trips_observed: u32,
    pub service_seconds_scheduled: f64,
    pub service_seconds_observed: f64,
    pub deviation: [u32; DEVIATION_BINS],
    pub deviation_sum: f64,
    pub headways: Headways,
    pub sched_headway_count: u32,
    pub sched_headway_sum: f64,
    pub sched_headway_squares: f64,
    pub occupancy: [u32; 9],
}

impl RouteHour {
    pub fn add(&mut self, other: &Self) {
        self.meters += other.meters;
        self.seconds += other.seconds;
        self.stopped_seconds += other.stopped_seconds;
        self.sched_meters += other.sched_meters;
        self.sched_seconds += other.sched_seconds;
        self.trips_scheduled += other.trips_scheduled;
        self.trips_observed += other.trips_observed;
        self.service_seconds_scheduled += other.service_seconds_scheduled;
        self.service_seconds_observed += other.service_seconds_observed;
        for (a, b) in self.deviation.iter_mut().zip(other.deviation) {
            *a += b;
        }
        self.deviation_sum += other.deviation_sum;
        self.headways.add(&other.headways);
        self.sched_headway_count += other.sched_headway_count;
        self.sched_headway_sum += other.sched_headway_sum;
        self.sched_headway_squares += other.sched_headway_squares;
        for (a, b) in self.occupancy.iter_mut().zip(other.occupancy) {
            *a += b;
        }
    }
}

/// One directional street segment in one service hour.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SegHour {
    pub seg: u32,
    pub hour: u8,
    pub meters: f32,
    pub seconds: f32,
    pub stopped_seconds: f32,
    pub pairs: u32,
}

/// One stop on one route and direction, in one time-of-day group.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct StopPeriod {
    pub route: u32,
    pub dir: u8,
    pub stop: u32,
    pub period: u8,
    pub passes: u32,
    pub scheduled: u32,
    pub zone_seconds: f32,
    pub zone_count: u32,
    pub deviation: [u32; DEVIATION_BINS],
    pub deviation_sum: f64,
    pub headways: Headways,
}

impl StopPeriod {
    pub fn add(&mut self, other: &Self) {
        self.passes += other.passes;
        self.scheduled += other.scheduled;
        self.zone_seconds += other.zone_seconds;
        self.zone_count += other.zone_count;
        for (a, b) in self.deviation.iter_mut().zip(other.deviation) {
            *a += b;
        }
        self.deviation_sum += other.deviation_sum;
        self.headways.add(&other.headways);
    }
}

/// Distinct vehicles on one route in one service hour.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct RouteVehicles {
    pub route: u32,
    pub hour: u8,
    pub vehicles: u32,
}

/// One observed trip.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TripRow {
    pub pattern: u32,
    pub route: u32,
    pub dir: u8,
    pub trip_id: String,
    pub vehicle: String,
    pub sched_start: i32,
    pub sched_end: i32,
    pub first_observed: i32,
    pub last_observed: i32,
    /// Share of the pattern's length seen moving.
    pub coverage: f32,
    /// Stop-to-stop time between the first and last stops observed, and the
    /// scheduled time between those same stops.
    pub observed_run: i32,
    pub scheduled_run: i32,
    pub first_stop: u16,
    pub last_stop: u16,
    pub end_deviation: Option<i32>,
    pub fixes: u32,
    pub off_route: u32,
}

impl TripRow {
    /// Covers enough of the route to count as a complete run.
    pub fn complete(&self) -> bool {
        self.coverage >= 0.9 && self.observed_run > 0 && self.scheduled_run > 0
    }
}

/// One stop passed by one trip. Stored separately because string-line charts
/// are the only thing that needs this grain.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct StopEvent {
    pub trip: u32,
    pub stop_index: u16,
    /// Seconds from the GTFS origin of the service date.
    pub observed: i32,
    pub scheduled: i32,
}

/// The funnel from raw rows to measured intervals. Counts are for one day.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Quality {
    pub rows: u64,
    pub no_trip: u64,
    pub no_vehicle: u64,
    pub bad_coordinate: u64,
    pub fallback_time: u64,
    pub differential: u64,
    pub fixes_unique: u64,
    pub fixes_trip_unmatched: u64,
    pub fixes_on_day: u64,
    pub off_route: u64,
    pub backward: u64,
    pub trips_scheduled: u32,
    pub trips_observed: u32,
    pub trips_complete: u32,
    pub pairs: u64,
    pub pairs_layover: u64,
    pub pairs_long_gap: u64,
    pub pairs_geometry: u64,
    pub pairs_too_fast: u64,
    pub pairs_standstill: u64,
    pub pairs_kept: u64,
    pub seconds_layover: f64,
    pub seconds_standstill: f64,
    pub seconds_kept: f64,
    pub meters_kept: f64,
    pub stops_expected: u64,
    pub stops_observed: u64,
    /// Distinct polls captured in each service hour.
    pub polls: [u32; SERVICE_HOURS],
    /// Five-minute periods within scheduled service with no capture at all.
    pub service_buckets: u32,
    pub empty_buckets: u32,
}

/// One service day's rollups. Indexes refer to the schedule named by `digest`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct DayCube {
    pub date: u32,
    pub digest: String,
    pub metric_version: u32,
    pub route_hours: Vec<RouteHour>,
    pub seg_hours: Vec<SegHour>,
    pub stop_periods: Vec<StopPeriod>,
    pub trips: Vec<TripRow>,
    /// Distinct vehicles per route and service hour. Summing across routes
    /// double-counts interlined vehicles, so the network has its own count.
    pub route_vehicles: Vec<RouteVehicles>,
    pub network_vehicles: Vec<u32>,
    pub quality: Quality,
    pub warnings: Vec<String>,
}

impl DayCube {
    pub fn service_date(&self) -> ServiceDate {
        ServiceDate(self.date)
    }
}

/// Encodes a value for the browser's local cache.
pub fn encode<T: Serialize>(value: &T) -> Result<Vec<u8>, String> {
    postcard::to_stdvec(value).map_err(|error| format!("Could not encode results: {error}"))
}

/// Decodes a value from the browser's local cache.
pub fn decode<'a, T: Deserialize<'a>>(bytes: &'a [u8]) -> Result<T, String> {
    postcard::from_bytes(bytes).map_err(|error| format!("Could not read cached results: {error}"))
}

/// Metadata and events that accompany a cube in the local cache.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct CachedSchedule {
    pub metric_version: u32,
    pub meta: ScheduleMeta,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deviation_bins_place_values_on_the_expected_side_of_each_edge() {
        assert_eq!(deviation_bin(-301), 0);
        assert_eq!(deviation_bin(-300), 1);
        assert_eq!(deviation_bin(-61), 2);
        assert_eq!(deviation_bin(-60), 3);
        assert_eq!(deviation_bin(0), 4);
        assert_eq!(deviation_bin(299), 7);
        assert_eq!(deviation_bin(300), 8);
        assert_eq!(deviation_bin(5000), DEVIATION_BINS - 1);
    }

    #[test]
    fn merging_route_hours_is_plain_addition() {
        let mut a = RouteHour {
            meters: 100.0,
            seconds: 10.0,
            trips_observed: 1,
            ..RouteHour::default()
        };
        a.deviation[2] = 3;
        let mut b = a.clone();
        b.deviation[2] = 4;
        a.add(&b);
        assert_eq!(a.meters, 200.0);
        assert_eq!(a.trips_observed, 2);
        assert_eq!(a.deviation[2], 7);
    }

    #[test]
    fn headway_classes_follow_their_definitions() {
        let mut h = Headways::default();
        h.record(100.0, 600.0); // bunched
        h.record(1000.0, 600.0); // gap, and over the wait allowance
        h.record(700.0, 600.0); // normal
        assert_eq!(h.count, 3);
        assert_eq!(h.bunched, 1);
        assert_eq!(h.gapped, 1);
        assert_eq!(h.wait_ok, 2);
    }

    #[test]
    fn cubes_round_trip_through_the_cache_encoding() {
        let cube = DayCube {
            date: 20261105,
            digest: "v1:x".into(),
            metric_version: METRIC_VERSION,
            seg_hours: vec![SegHour {
                seg: 3,
                hour: 7,
                meters: 1.5,
                seconds: 2.5,
                stopped_seconds: 0.5,
                pairs: 4,
            }],
            ..DayCube::default()
        };
        let bytes = encode(&cube).unwrap();
        assert_eq!(decode::<DayCube>(&bytes).unwrap(), cube);
        assert!(decode::<DayCube>(&bytes[..3]).is_err());
    }
}
