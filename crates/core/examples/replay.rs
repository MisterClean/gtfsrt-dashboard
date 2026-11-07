//! Replays a service day from CSV exports, for checking results against real data
//! without a browser. See `docs/validation.md` for how the exports are made.
//!
//! ```text
//! cargo run --release -p transit-core --example replay -- <dir> <date> <utc-offset-hours> [--dump <out-dir>]
//! ```

use std::{collections::HashMap, env, error::Error, fs, path::Path, time::Instant};
use transit_core::cube;
use transit_core::day::process_day;
use transit_core::rt::{RawFix, RtBuffer};
use transit_core::schedule::{RouteMeta, ScheduleBuilder, StopMeta, parse_gtfs_time};
use transit_core::time::{Clock, ServiceDate};

type Rows = (Vec<String>, csv::StringRecordsIntoIter<fs::File>);

fn open(dir: &Path, name: &str) -> Result<Option<Rows>, Box<dyn Error>> {
    let path = dir.join(format!("{name}.csv"));
    if !path.exists() {
        return Ok(None);
    }
    let mut reader = csv::Reader::from_path(path)?;
    let headers = reader.headers()?.iter().map(str::to_owned).collect();
    Ok(Some((headers, reader.into_records())))
}

fn index(headers: &[String]) -> HashMap<&str, usize> {
    headers
        .iter()
        .enumerate()
        .map(|(i, h)| (h.as_str(), i))
        .collect()
}

fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<String> = env::args().collect();
    let dir = Path::new(&args[1]);
    let date = ServiceDate::parse(&args[2]).ok_or("bad date")?;
    let offset: i32 = args[3].parse()?;
    let dump = args
        .iter()
        .position(|a| a == "--dump")
        .map(|i| args[i + 1].clone());
    let clock = Clock::fixed(offset * 3600);

    let started = Instant::now();
    let mut builder = ScheduleBuilder::new("replay");
    if let Some((headers, rows)) = open(dir, "agency")? {
        let col = index(&headers);
        for row in rows {
            let row = row?;
            builder.set_timezone(row.get(col["agency_timezone"]).unwrap_or(""));
        }
    }
    {
        let (headers, rows) = open(dir, "routes")?.ok_or("routes.csv")?;
        let col = index(&headers);
        let get = |row: &csv::StringRecord, name: &str| {
            col.get(name)
                .and_then(|i| row.get(*i))
                .unwrap_or("")
                .to_owned()
        };
        for row in rows {
            let row = row?;
            builder.add_route(RouteMeta {
                id: get(&row, "route_id"),
                short_name: get(&row, "route_short_name"),
                long_name: get(&row, "route_long_name"),
                route_type: get(&row, "route_type").parse().ok(),
                color: get(&row, "route_color"),
                text_color: get(&row, "route_text_color"),
            });
        }
    }
    {
        let (headers, rows) = open(dir, "stops")?.ok_or("stops.csv")?;
        let col = index(&headers);
        let get = |row: &csv::StringRecord, name: &str| {
            col.get(name)
                .and_then(|i| row.get(*i))
                .unwrap_or("")
                .to_owned()
        };
        for row in rows {
            let row = row?;
            builder.add_stop(StopMeta {
                id: get(&row, "stop_id"),
                code: get(&row, "stop_code"),
                name: get(&row, "stop_name"),
                lat: get(&row, "stop_lat").parse().unwrap_or(f64::NAN),
                lon: get(&row, "stop_lon").parse().unwrap_or(f64::NAN),
            });
        }
    }
    if let Some((headers, rows)) = open(dir, "shapes")? {
        let col = index(&headers);
        for row in rows {
            let row = row?;
            builder.add_shape_point(
                &row[col["shape_id"]],
                row[col["shape_pt_sequence"]].parse().unwrap_or(0),
                row[col["shape_pt_lat"]].parse().unwrap_or(f64::NAN),
                row[col["shape_pt_lon"]].parse().unwrap_or(f64::NAN),
            );
        }
    }
    if let Some((headers, rows)) = open(dir, "calendar")? {
        let col = index(&headers);
        for row in rows {
            let row = row?;
            let flag = |name: &str| &row[col[name]] == "1";
            builder.add_calendar(
                &row[col["service_id"]],
                [
                    flag("monday"),
                    flag("tuesday"),
                    flag("wednesday"),
                    flag("thursday"),
                    flag("friday"),
                    flag("saturday"),
                    flag("sunday"),
                ],
                row[col["start_date"]].parse().unwrap_or(0),
                row[col["end_date"]].parse().unwrap_or(0),
            );
        }
    }
    if let Some((headers, rows)) = open(dir, "calendar_dates")? {
        let col = index(&headers);
        for row in rows {
            let row = row?;
            builder.add_calendar_date(
                &row[col["service_id"]],
                row[col["date"]].parse().unwrap_or(0),
                row[col["exception_type"]].parse().unwrap_or(0),
            );
        }
    }
    {
        let (headers, rows) = open(dir, "trips")?.ok_or("trips.csv")?;
        let col = index(&headers);
        for row in rows {
            let row = row?;
            let shape = col
                .get("shape_id")
                .and_then(|i| row.get(*i))
                .filter(|s| !s.is_empty());
            builder.add_trip(
                &row[col["trip_id"]],
                &row[col["route_id"]],
                &row[col["service_id"]],
                col.get("direction_id")
                    .and_then(|i| row.get(*i))
                    .and_then(|d| d.parse().ok()),
                shape,
                col.get("trip_headsign")
                    .and_then(|i| row.get(*i))
                    .unwrap_or(""),
            );
        }
    }
    {
        let (headers, rows) = open(dir, "stop_times")?.ok_or("stop_times.csv")?;
        let col = index(&headers);
        for row in rows {
            let row = row?;
            builder.add_stop_time(
                &row[col["trip_id"]],
                &row[col["stop_id"]],
                row[col["stop_sequence"]].parse().unwrap_or(0),
                parse_gtfs_time(&row[col["arrival_time"]]),
                parse_gtfs_time(&row[col["departure_time"]]),
                col.get("timepoint")
                    .and_then(|i| row.get(*i))
                    .filter(|t| !t.is_empty())
                    .map(|t| t == "1"),
            );
        }
    }
    let schedule = builder.build()?;
    println!(
        "schedule: {} routes, {} stops, {} trips, {} patterns, {} lines, {} segments in {:?}",
        schedule.routes.len(),
        schedule.stops.len(),
        schedule.trips.len(),
        schedule.patterns.len(),
        schedule.polylines.len(),
        schedule.segs.len(),
        started.elapsed()
    );

    let started = Instant::now();
    let mut buffer = RtBuffer::default();
    let (headers, rows) = open(dir, "fixes")?.ok_or("fixes.csv")?;
    let col = index(&headers);
    for row in rows {
        let row = row?;
        let opt = |name: &str| {
            col.get(name)
                .and_then(|i| row.get(*i))
                .filter(|v| !v.is_empty())
                .map(str::as_bytes)
        };
        buffer.push(RawFix {
            fetch: row[col["fetch"]].parse().unwrap_or(f64::NAN),
            timestamp: row[col["ts"]].parse().unwrap_or(f64::NAN),
            lat: row[col["lat"]].parse().unwrap_or(f32::NAN),
            lon: row[col["lon"]].parse().unwrap_or(f32::NAN),
            trip_id: opt("trip_id"),
            vehicle_id: opt("vehicle_id"),
            route_id: opt("route_id"),
            start_date: opt("start_date"),
            start_time: opt("start_time"),
            occupancy: row[col["occupancy"]].parse().unwrap_or(-1),
            differential: false,
        });
    }
    println!(
        "ingested {} fixes in {:?}",
        buffer.fixes.len(),
        started.elapsed()
    );

    let started = Instant::now();
    let result = process_day(
        &schedule,
        &mut buffer,
        date,
        &clock,
        &cube::Coverage::complete(),
        &[],
    )?;
    println!("processed day in {:?}", started.elapsed());
    let cube = &result.cube;
    let q = cube.quality;
    println!("{q:#?}");
    println!(
        "rollups: {} route-hours, {} seg-hours, {} stop-periods, {} trips, {} events",
        cube.route_hours.len(),
        cube.seg_hours.len(),
        cube.stop_periods.len(),
        cube.trips.len(),
        result.events.len()
    );
    println!(
        "encoded: cube {} KB, events {} KB, schedule {} KB",
        cube::encode(cube)?.len() / 1024,
        cube::encode(&result.events)?.len() / 1024,
        cube::encode(&schedule.meta())?.len() / 1024
    );

    let (m, s): (f64, f64) = cube
        .route_hours
        .iter()
        .fold((0.0, 0.0), |a, r| (a.0 + r.meters, a.1 + r.seconds));
    println!("network operating speed: {:.2} mph", m / s * 2.23694);
    let (sm, ss): (f64, f64) = cube.route_hours.iter().fold((0.0, 0.0), |a, r| {
        (a.0 + r.sched_meters, a.1 + r.sched_seconds)
    });
    println!("network scheduled speed: {:.2} mph", sm / ss * 2.23694);
    let bins = cube
        .route_hours
        .iter()
        .fold([0_u64; cube::DEVIATION_BINS], |mut acc, r| {
            for (a, b) in acc.iter_mut().zip(r.deviation) {
                *a += u64::from(b);
            }
            acc
        });
    let total: u64 = bins.iter().sum();
    let on_time: u64 = bins[3..=7].iter().sum();
    println!(
        "OTP (-1..+5 min) at timepoints: {:.1}% of {total}",
        on_time as f64 * 100.0 / total as f64
    );
    println!("deviation bins: {bins:?}");

    if let Some(out) = dump {
        fs::create_dir_all(&out)?;
        let mut hourly = csv::Writer::from_path(Path::new(&out).join("route_hour.csv"))?;
        hourly.write_record([
            "route",
            "dir",
            "hour",
            "meters",
            "seconds",
            "stopped_seconds",
            "sched_meters",
            "sched_seconds",
            "trips_scheduled",
            "trips_observed",
            "on_time",
            "timed",
            "headways",
            "bunched",
            "gapped",
        ])?;
        for r in &cube.route_hours {
            hourly.write_record([
                schedule.routes[r.route as usize].id.clone(),
                r.dir.to_string(),
                r.hour.to_string(),
                r.meters.to_string(),
                r.seconds.to_string(),
                r.stopped_seconds.to_string(),
                r.sched_meters.to_string(),
                r.sched_seconds.to_string(),
                r.trips_scheduled.to_string(),
                r.trips_observed.to_string(),
                r.deviation[3..=7].iter().sum::<u32>().to_string(),
                r.deviation.iter().sum::<u32>().to_string(),
                r.headways.count.to_string(),
                r.headways.bunched.to_string(),
                r.headways.gapped.to_string(),
            ])?;
        }
        hourly.flush()?;
        let mut trips = csv::Writer::from_path(Path::new(&out).join("trips.csv"))?;
        trips.write_record([
            "trip_id",
            "route",
            "dir",
            "vehicle",
            "sched_start",
            "sched_end",
            "first_observed",
            "last_observed",
            "coverage",
            "observed_run",
            "scheduled_run",
            "fixes",
            "off_route",
            "end_deviation",
        ])?;
        for t in &cube.trips {
            trips.write_record([
                t.trip_id.clone(),
                schedule.routes[t.route as usize].id.clone(),
                t.dir.to_string(),
                t.vehicle.clone(),
                t.sched_start.to_string(),
                t.sched_end.to_string(),
                t.first_observed.to_string(),
                t.last_observed.to_string(),
                t.coverage.to_string(),
                t.observed_run.to_string(),
                t.scheduled_run.to_string(),
                t.fixes.to_string(),
                t.off_route.to_string(),
                t.end_deviation.map_or(String::new(), |d| d.to_string()),
            ])?;
        }
        trips.flush()?;
        let mut events = csv::Writer::from_path(Path::new(&out).join("events.csv"))?;
        events.write_record([
            "trip_id",
            "route",
            "stop_id",
            "stop_index",
            "observed",
            "scheduled",
        ])?;
        for e in &result.events {
            let t = &cube.trips[e.trip as usize];
            let p = &schedule.patterns[t.pattern as usize];
            events.write_record([
                t.trip_id.clone(),
                schedule.routes[t.route as usize].id.clone(),
                schedule.stops[p.stops[e.stop_index as usize] as usize]
                    .id
                    .clone(),
                e.stop_index.to_string(),
                e.observed.to_string(),
                e.scheduled.to_string(),
            ])?;
        }
        events.flush()?;
    }
    Ok(())
}
