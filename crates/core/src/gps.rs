//! A fallback for feeds that can't be joined to a schedule.
//!
//! Some agencies publish realtime trip IDs that match no archived schedule
//! version, and some have no schedule in the archive at all. Without that join
//! there are no stop times, so on-time performance and headways are off the
//! table. Consecutive GPS fixes still give speed by street and hour, labelled
//! with the route the feed reports. Distance here is straight-line between fixes
//! rather than along the route, and layovers can only be guessed from a vehicle
//! standing still, so these figures are clearly marked as less precise.

use crate::cube::{DayCube, METRIC_VERSION, Quality, RouteHour, RouteVehicles, SegHour};
use crate::geo::chord_m;
use crate::rt::{Fix, RtBuffer};
use crate::schedule::{Grid, RouteMeta, ScheduleMeta, SegKey, SegMeta};
use crate::time::{Clock, SERVICE_HOURS, ServiceDate, service_hour};
use rustc_hash::{FxHashMap, FxHashSet};

/// Longest gap between fixes that still counts as one movement. Shorter than the
/// schedule-joined limit, because a straight line across a long gap cuts corners.
const MAX_GAP_S: f32 = 120.0;
const MAX_SPEED_MPS: f32 = 35.8;
const STOPPED_MPS: f32 = 0.9;
const STANDSTILL_MOVE_M: f32 = 30.48;
/// Shorter than the schedule-joined rule, because this also has to catch layovers.
const STANDSTILL_S: f32 = 300.0;
/// Below this, GPS noise says more about the bearing than the vehicle does.
const MIN_BEARING_MOVE_M: f32 = 15.0;

/// A day's rollups plus the routes and segments they refer to.
pub struct GpsDay {
    pub meta: ScheduleMeta,
    pub cube: DayCube,
}

struct Pair {
    route: u32,
    t0: u32,
    t1: u32,
    meters: f32,
    from: (f32, f32),
    to: (f32, f32),
}

/// Identifies the metadata for a GPS-only day.
pub fn gps_digest(date: ServiceDate) -> String {
    format!("gps|{date}")
}

/// Builds rollups for `date` from buffered fixes using position alone. Routes take
/// their names from `known_routes` when the IDs match, and otherwise show the ID
/// the feed reported.
pub fn process_gps_day(
    buffer: &mut RtBuffer,
    known_routes: &[RouteMeta],
    date: ServiceDate,
    clock: &Clock,
) -> Result<GpsDay, String> {
    let origin = clock
        .service_origin(date)
        .ok_or_else(|| format!("{date} is outside the supported calendar."))?;
    // The 24 hours from 3 AM belong to this date, so a fix counts on exactly one.
    let window_start = origin + 3 * 3600;
    let window_end = window_start + 24 * 3600;

    let mut fixes: Vec<Fix> = buffer
        .fixes
        .iter()
        .filter(|fix| (window_start..window_end).contains(&i64::from(fix.time)))
        .copied()
        .collect();
    fixes.sort_unstable_by_key(|fix| (fix.vehicle, fix.time));
    fixes.dedup_by_key(|fix| (fix.vehicle, fix.time));

    let mut quality = Quality {
        fixes_unique: fixes.len() as u64,
        fixes_trip_unmatched: fixes.len() as u64,
        ..Quality::default()
    };
    add_hour_counts(buffer, window_start, window_end, &mut quality);

    let center = mean_position(&fixes);
    let grid = Grid::for_latitude(center.0);
    let mut routes: Vec<RouteMeta> = Vec::new();
    let mut route_index: FxHashMap<u32, u32> = FxHashMap::default();
    let mut segs: Vec<SegMeta> = Vec::new();
    let mut seg_index: FxHashMap<SegKey, u32> = FxHashMap::default();
    let mut route_hours: FxHashMap<(u32, u8), RouteHour> = FxHashMap::default();
    let mut seg_hours: FxHashMap<(u32, u8), SegHour> = FxHashMap::default();
    let mut vehicles: FxHashSet<(u32, u8, u32)> = FxHashSet::default();

    for vehicle_fixes in fixes.chunk_by(|a, b| a.vehicle == b.vehicle) {
        let pairs = usable_pairs(vehicle_fixes, buffer, &mut quality);
        let mut bearing_sector = 0_u8;
        for pair in pairs {
            let seconds = (pair.t1 - pair.t0) as f32;
            let route = *route_index.entry(pair.route).or_insert_with(|| {
                let id = buffer.routes.get(pair.route);
                let meta = known_routes
                    .iter()
                    .find(|r| r.id == id)
                    .cloned()
                    .unwrap_or_else(|| RouteMeta {
                        id: id.to_owned(),
                        short_name: id.to_owned(),
                        long_name: String::new(),
                        route_type: None,
                        color: String::new(),
                        text_color: String::new(),
                    });
                routes.push(meta);
                routes.len() as u32 - 1
            });
            if pair.meters >= MIN_BEARING_MOVE_M {
                bearing_sector = sector_of(pair.from, pair.to);
            }
            let middle = (i64::from(pair.t0) + i64::from(pair.t1)) / 2 - origin;
            let hour = service_hour(middle) as u8;
            let stopped = pair.meters / seconds < STOPPED_MPS;
            let (x, y) = grid.cell(
                f64::from(pair.from.0 + pair.to.0) / 2.0,
                f64::from(pair.from.1 + pair.to.1) / 2.0,
            );
            let key = SegKey {
                route,
                dir: 2,
                x,
                y,
                sector: bearing_sector,
            };
            let seg = *seg_index.entry(key).or_insert_with(|| {
                segs.push(SegMeta {
                    key,
                    length_m: 0.0,
                    path: Vec::new(),
                });
                segs.len() as u32 - 1
            });
            let meta = &mut segs[seg as usize];
            if pair.meters > meta.length_m {
                meta.length_m = pair.meters;
                meta.path = vec![[pair.from.1, pair.from.0], [pair.to.1, pair.to.0]];
            }
            let row = route_hours
                .entry((route, hour))
                .or_insert_with(|| RouteHour {
                    route,
                    dir: 2,
                    hour,
                    ..RouteHour::default()
                });
            row.meters += f64::from(pair.meters);
            row.seconds += f64::from(seconds);
            let cell = seg_hours.entry((seg, hour)).or_insert_with(|| SegHour {
                seg,
                hour,
                ..SegHour::default()
            });
            cell.meters += pair.meters;
            cell.seconds += seconds;
            cell.pairs += 1;
            if stopped {
                row.stopped_seconds += f64::from(seconds);
                cell.stopped_seconds += seconds;
            }
            quality.seconds_kept += f64::from(seconds);
            quality.meters_kept += f64::from(pair.meters);
            vehicles.insert((route, hour, vehicle_fixes[0].vehicle));
        }
    }

    add_polls(buffer, origin, &mut quality);
    // Segments with no drawable line came from pairs that never moved.
    let segs_with_paths: Vec<SegMeta> = segs
        .into_iter()
        .map(|mut seg| {
            if seg.path.is_empty() {
                let (lat, lon) = (
                    (f64::from(seg.key.y) + 0.5) * grid.lat_step,
                    (f64::from(seg.key.x) + 0.5) * grid.lon_step,
                );
                seg.path = vec![[lon as f32, lat as f32], [lon as f32, lat as f32]];
            }
            seg
        })
        .collect();

    let mut by_route: FxHashMap<(u32, u8), u32> = FxHashMap::default();
    let mut network: FxHashSet<(u8, u32)> = FxHashSet::default();
    for (route, hour, vehicle) in &vehicles {
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
    route_vehicles.sort_by_key(|row| (row.route, row.hour));
    let mut network_vehicles = vec![0_u32; SERVICE_HOURS];
    for (hour, _) in network {
        network_vehicles[usize::from(hour)] += 1;
    }

    let mut route_rows: Vec<RouteHour> = route_hours.into_values().collect();
    route_rows.sort_by_key(|row| (row.route, row.hour));
    let mut seg_rows: Vec<SegHour> = seg_hours.into_values().collect();
    seg_rows.sort_by_key(|row| (row.seg, row.hour));

    let digest = gps_digest(date);
    Ok(GpsDay {
        meta: ScheduleMeta {
            digest: digest.clone(),
            timezone: None,
            center,
            routes,
            stops: Vec::new(),
            segs: segs_with_paths,
            patterns: Vec::new(),
        },
        cube: DayCube {
            date: date.0,
            digest,
            metric_version: METRIC_VERSION,
            route_hours: route_rows,
            seg_hours: seg_rows,
            route_vehicles,
            network_vehicles,
            quality,
            warnings: vec![
                "This day could not be joined to a schedule, so it shows GPS speeds only: no on-time performance, headways or run times. Speeds are measured between consecutive positions, and may run a little low on winding routes."
                    .to_owned(),
            ],
            ..DayCube::default()
        },
    })
}

fn sector_of(from: (f32, f32), to: (f32, f32)) -> u8 {
    let k = f64::from(from.0).to_radians().cos();
    let dx = f64::from(to.1 - from.1) * k;
    let dy = f64::from(to.0 - from.0);
    let bearing = dx.atan2(dy).to_degrees().rem_euclid(360.0);
    (((bearing + 22.5) / 45.0).floor() as u32 % 8) as u8
}

/// Consecutive fixes that pass the rules, with long stationary runs removed.
fn usable_pairs(fixes: &[Fix], buffer: &RtBuffer, quality: &mut Quality) -> Vec<Pair> {
    let mut kept = Vec::with_capacity(fixes.len());
    let mut stationary: Vec<Pair> = Vec::new();
    let mut stationary_seconds = 0.0_f32;

    let flush = |stationary: &mut Vec<Pair>,
                 seconds: &mut f32,
                 kept: &mut Vec<Pair>,
                 quality: &mut Quality| {
        if *seconds >= STANDSTILL_S {
            quality.pairs_standstill += stationary.len() as u64;
            quality.seconds_standstill += f64::from(*seconds);
            stationary.clear();
        } else {
            quality.pairs_kept += stationary.len() as u64;
            kept.append(stationary);
        }
        *seconds = 0.0;
    };

    for window in fixes.windows(2) {
        let (a, b) = (window[0], window[1]);
        quality.pairs += 1;
        let seconds = (b.time - a.time) as f32;
        let route = buffer.descriptors[a.descriptor as usize].route;
        if route != buffer.descriptors[b.descriptor as usize].route
            || buffer.routes.get(route).is_empty()
        {
            continue;
        }
        if seconds > MAX_GAP_S {
            quality.pairs_long_gap += 1;
            flush(&mut stationary, &mut stationary_seconds, &mut kept, quality);
            continue;
        }
        let meters = chord_m(
            f64::from(a.lat),
            f64::from(a.lon),
            f64::from(b.lat),
            f64::from(b.lon),
        ) as f32;
        if meters / seconds > MAX_SPEED_MPS {
            quality.pairs_too_fast += 1;
            continue;
        }
        let pair = Pair {
            route,
            t0: a.time,
            t1: b.time,
            meters,
            from: (a.lat, a.lon),
            to: (b.lat, b.lon),
        };
        if meters <= STANDSTILL_MOVE_M {
            stationary_seconds += seconds;
            stationary.push(pair);
        } else {
            flush(&mut stationary, &mut stationary_seconds, &mut kept, quality);
            quality.pairs_kept += 1;
            kept.push(pair);
        }
    }
    flush(&mut stationary, &mut stationary_seconds, &mut kept, quality);
    kept
}

fn mean_position(fixes: &[Fix]) -> (f64, f64) {
    if fixes.is_empty() {
        return (0.0, 0.0);
    }
    let count = fixes.len() as f64;
    (
        fixes.iter().map(|f| f64::from(f.lat)).sum::<f64>() / count,
        fixes.iter().map(|f| f64::from(f.lon)).sum::<f64>() / count,
    )
}

fn add_hour_counts(buffer: &RtBuffer, start: i64, end: i64, quality: &mut Quality) {
    for (hour, counts) in &buffer.hours {
        let epoch = i64::from(*hour) * 3600;
        if epoch >= start && epoch < end {
            quality.rows += u64::from(counts.rows);
            quality.no_trip += u64::from(counts.no_trip);
            quality.no_vehicle += u64::from(counts.no_vehicle);
            quality.bad_coordinate += u64::from(counts.bad_coordinate);
            quality.fallback_time += u64::from(counts.fallback_time);
            quality.differential += u64::from(counts.differential);
        }
    }
}

fn add_polls(buffer: &RtBuffer, origin: i64, quality: &mut Quality) {
    let mut polls = buffer.polls.clone();
    polls.sort_unstable();
    polls.dedup();
    for poll in polls {
        let offset = i64::from(poll) - origin;
        if (0..SERVICE_HOURS as i64 * 3600).contains(&offset) {
            quality.polls[service_hour(offset)] += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rt::RawFix;

    const DATE: ServiceDate = ServiceDate(20261105);

    fn clock() -> Clock {
        Clock::fixed(-6 * 3600)
    }

    /// One vehicle moving north at `step` degrees of latitude every 20 seconds.
    fn drive(
        buffer: &mut RtBuffer,
        vehicle: &str,
        route: &str,
        start_hour: i64,
        fixes: i64,
        step: f64,
    ) {
        let origin = clock().service_origin(DATE).unwrap();
        for i in 0..fixes {
            let epoch = origin + start_hour * 3600 + i * 20;
            buffer.push(RawFix {
                fetch: epoch as f64,
                timestamp: epoch as f64,
                lat: (43.0 + step * i as f64) as f32,
                lon: -89.0,
                trip_id: Some(b"UNMATCHED"),
                vehicle_id: Some(vehicle.as_bytes()),
                route_id: Some(route.as_bytes()),
                start_date: None,
                start_time: None,
                occupancy: -1,
                differential: false,
            });
        }
    }

    #[test]
    fn measures_speed_from_consecutive_positions() {
        let mut buffer = RtBuffer::default();
        // 0.001 degrees is about 111 m, so 5.6 m/s.
        drive(&mut buffer, "V1", "26", 8, 60, 0.001);
        let day = process_gps_day(&mut buffer, &[], DATE, &clock()).unwrap();
        let row = &day.cube.route_hours[0];
        assert_eq!(row.hour, 8);
        let speed = row.meters / row.seconds;
        assert!((speed - 5.566).abs() < 0.05, "{speed}");
        assert_eq!(day.meta.routes[0].id, "26");
        assert_eq!(day.cube.network_vehicles[8], 1);
    }

    #[test]
    fn every_segment_has_a_drawable_line_and_valid_references() {
        let mut buffer = RtBuffer::default();
        drive(&mut buffer, "V1", "26", 8, 60, 0.001);
        let day = process_gps_day(&mut buffer, &[], DATE, &clock()).unwrap();
        assert!(!day.meta.segs.is_empty());
        assert!(day.meta.segs.iter().all(|seg| seg.path.len() >= 2));
        assert!(
            day.cube
                .seg_hours
                .iter()
                .all(|cell| (cell.seg as usize) < day.meta.segs.len())
        );
        let seg_seconds: f32 = day.cube.seg_hours.iter().map(|s| s.seconds).sum();
        let route_seconds: f64 = day.cube.route_hours.iter().map(|r| r.seconds).sum();
        assert!((f64::from(seg_seconds) - route_seconds).abs() < 1.0);
    }

    #[test]
    fn a_long_stationary_run_is_treated_as_a_layover() {
        let mut buffer = RtBuffer::default();
        drive(&mut buffer, "V1", "26", 8, 60, 0.0);
        let day = process_gps_day(&mut buffer, &[], DATE, &clock()).unwrap();
        assert!(day.cube.route_hours.is_empty());
        assert!(day.cube.quality.pairs_standstill > 0);
    }

    #[test]
    fn a_short_stop_counts_as_ordinary_delay() {
        let mut buffer = RtBuffer::default();
        drive(&mut buffer, "V1", "26", 8, 10, 0.001);
        // Sixty seconds at a red light, at the end of the previous run.
        let origin = clock().service_origin(DATE).unwrap();
        for i in 10..13 {
            let epoch = origin + 8 * 3600 + i * 20;
            buffer.push(RawFix {
                fetch: epoch as f64,
                timestamp: epoch as f64,
                lat: 43.009,
                lon: -89.0,
                trip_id: Some(b"UNMATCHED"),
                vehicle_id: Some(b"V1"),
                route_id: Some(b"26"),
                start_date: None,
                start_time: None,
                occupancy: -1,
                differential: false,
            });
        }
        let day = process_gps_day(&mut buffer, &[], DATE, &clock()).unwrap();
        let stopped: f64 = day.cube.route_hours.iter().map(|r| r.stopped_seconds).sum();
        assert!(stopped >= 40.0, "{stopped}");
    }

    #[test]
    fn known_route_ids_keep_their_names_and_types() {
        let mut buffer = RtBuffer::default();
        drive(&mut buffer, "V1", "26", 8, 60, 0.001);
        let known = [RouteMeta {
            id: "26".into(),
            short_name: "26".into(),
            long_name: "Market Street".into(),
            route_type: Some(3),
            color: String::new(),
            text_color: String::new(),
        }];
        let day = process_gps_day(&mut buffer, &known, DATE, &clock()).unwrap();
        assert_eq!(day.meta.routes[0].long_name, "Market Street");
    }

    #[test]
    fn fixes_outside_the_day_or_without_a_route_are_ignored() {
        let mut buffer = RtBuffer::default();
        drive(&mut buffer, "V1", "26", 40, 60, 0.001);
        drive(&mut buffer, "V2", "", 8, 60, 0.001);
        let day = process_gps_day(&mut buffer, &[], DATE, &clock()).unwrap();
        assert!(day.cube.route_hours.is_empty());
    }

    #[test]
    fn impossible_jumps_are_dropped() {
        let mut buffer = RtBuffer::default();
        drive(&mut buffer, "V1", "26", 8, 5, 0.1);
        let day = process_gps_day(&mut buffer, &[], DATE, &clock()).unwrap();
        assert!(day.cube.route_hours.is_empty());
        assert_eq!(day.cube.quality.pairs_too_fast, 4);
    }

    #[test]
    fn gps_only_days_merge_with_the_library_like_any_other_day() {
        let mut buffer = RtBuffer::default();
        drive(&mut buffer, "V1", "26", 8, 60, 0.001);
        let day = process_gps_day(&mut buffer, &[], DATE, &clock()).unwrap();
        let mut library = crate::library::Library::default();
        library.add_schedule(&day.meta);
        library.add_day(day.cube, None).unwrap();
        let selection = crate::report::Selection {
            dates: vec![DATE.0],
            mode: crate::mode::Mode::All,
            early_s: -60,
            late_s: 300,
            periods: crate::report::Periods::default(),
        };
        let merged = crate::report::Merged::compute(&library, selection);
        let overview = crate::report::overview(&library, &merged);
        assert!(overview.speed.is_some());
        assert_eq!(overview.on_time.total, 0);
        assert_eq!(crate::report::route_scores(&library, &merged).len(), 1);
        assert!(
            !crate::report::network_map(&library, &merged, None)
                .features
                .is_empty()
        );
    }
}
