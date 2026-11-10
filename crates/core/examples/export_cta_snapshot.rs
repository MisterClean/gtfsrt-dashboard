//! Builds a read-only CTA Routes snapshot with the same reports as the web app.
//!
//! Run after preparing the CTA CSVs and coverage metadata:
//!
//! ```text
//! cargo run --release -p transit-core --example export_cta_snapshot -- .cache/cta .cache/cta/snapshot
//! ```

#[path = "support/cta_schedule.rs"]
mod cta_schedule;

use std::{
    collections::{BTreeMap, HashMap, HashSet},
    env,
    error::Error,
    fs::{self, File},
    io::{BufWriter, ErrorKind, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Instant, SystemTime, UNIX_EPOCH},
};

use csv::StringRecord;
use cta_schedule::Headsigns;
use serde::{Deserialize, Serialize};
use transit_core::{
    cube::{Coverage, DayStatus},
    day::process_day,
    geo::valid_coordinate,
    library::Library,
    mode::Mode,
    report::{self, Merged, NetworkMap, RouteDetail, Selection, StringLine},
    rt::{RawFix, RtBuffer},
    schedule::{Schedule, Trip},
    time::{Clock, SERVICE_HOURS, ServiceDate},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Archive {
    requested_dates: Vec<String>,
    timezone: String,
    clock_samples: Vec<(i64, i32)>,
    sources: Vec<Source>,
    dates: BTreeMap<String, ArchiveDate>,
}

#[derive(Deserialize, Serialize)]
struct Source {
    label: String,
    url: String,
}

#[derive(Deserialize)]
struct ArchiveDate {
    gaps: Vec<Gap>,
}

#[derive(Deserialize)]
struct Gap {
    start: String,
    end: String,
    note: String,
}

#[derive(Deserialize)]
struct Position<'a> {
    ts: u64,
    vehicle_ts: Option<u64>,
    route: &'a str,
    pid: &'a str,
    vehicle_id: &'a str,
    destination: &'a str,
    lat: Option<f32>,
    lon: Option<f32>,
    sched_start_sec: Option<i32>,
    sched_start_date: &'a str,
}

#[derive(Default)]
struct MatchCount {
    eligible: u64,
    matched: u64,
}

impl MatchCount {
    fn add(&mut self, matched: bool) {
        self.eligible += 1;
        self.matched += u64::from(matched);
    }

    fn rate(&self) -> Option<f64> {
        (self.eligible != 0).then(|| self.matched as f64 / self.eligible as f64)
    }

    fn merge(&mut self, other: Self) {
        self.eligible += other.eligible;
        self.matched += other.matched;
    }
}

#[derive(Clone, Copy)]
struct Candidate<'a> {
    trip: &'a Trip,
    pid: Option<u32>,
    headsigns: Option<&'a Headsigns>,
}

struct RouteTrips<'a> {
    by_start: HashMap<i32, Vec<Candidate<'a>>>,
    pids: HashSet<u32>,
}

type TripIndex<'a> = HashMap<&'a str, RouteTrips<'a>>;

fn pattern_pid(shape: &str) -> Option<u32> {
    // CTA shape IDs in this feed are the three-digit signup and five-digit pattern.
    if shape.len() != 8 || !shape.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    shape[3..].parse().ok()
}

fn trip_index<'a>(
    schedule: &'a Schedule,
    headsigns: &'a HashMap<String, Headsigns>,
    date: ServiceDate,
) -> TripIndex<'a> {
    let mut routes = TripIndex::new();
    for trip in &schedule.trips {
        if !schedule.service_active(trip, date) {
            continue;
        }
        let Some(&start) = schedule.trip_times(trip).1.first() else {
            continue;
        };
        let pattern = &schedule.patterns[trip.pattern as usize];
        let route = routes
            .entry(schedule.routes[trip.route as usize].id.as_str())
            .or_insert_with(|| RouteTrips {
                by_start: HashMap::new(),
                pids: HashSet::new(),
            });
        let pid = pattern_pid(&pattern.shape_id);
        route.pids.extend(pid);
        route.by_start.entry(start).or_default().push(Candidate {
            trip,
            pid,
            headsigns: headsigns.get(&trip.id),
        });
    }
    routes
}

fn unique<T>(mut candidates: impl Iterator<Item = T>) -> Option<T> {
    let first = candidates.next()?;
    candidates.next().is_none().then_some(first)
}

impl RouteTrips<'_> {
    fn resolve(&self, position: &Position<'_>) -> Option<&Trip> {
        let candidates = self.by_start.get(&position.sched_start_sec?)?;
        let pid = position.pid.parse::<u32>().ok()?;
        if self.pids.contains(&pid) {
            return unique(candidates.iter().filter(|item| item.pid == Some(pid)))
                .map(|item| item.trip);
        }
        // Tracker sometimes supplies a substitute pattern ID outside the static
        // signup. Only accept an exact, unambiguous destination at that departure.
        unique(candidates.iter().filter(|item| {
            item.headsigns
                .is_some_and(|headsigns| headsigns.includes(position.destination))
        }))
        .map(|item| item.trip)
    }
}

fn ingest(
    dir: &Path,
    date: &str,
    archive_date: &str,
    until: i64,
    index: &TripIndex<'_>,
    buffer: &mut RtBuffer,
    by_route: &mut BTreeMap<String, MatchCount>,
) -> Result<MatchCount, Box<dyn Error>> {
    let mut reader = cta_schedule::open(dir, archive_date)?;
    let headers = reader.headers()?.clone();
    let mut row = StringRecord::new();
    // Reuse the most recent route key in the route-sorted files.
    let mut route_id = String::new();
    let mut route_matches = MatchCount::default();
    let mut route_trips = None;
    let mut totals = MatchCount::default();
    while reader.read_record(&mut row)? {
        let position: Position<'_> = row.deserialize(Some(&headers))?;
        let fetch = position.ts as f64 / 1_000.0;
        if position.sched_start_date != date || fetch >= until as f64 {
            continue;
        }
        if position.route != route_id {
            if !route_id.is_empty() {
                by_route.entry(route_id).or_default().merge(route_matches);
            }
            route_id = position.route.to_owned();
            route_matches = MatchCount::default();
            route_trips = index.get(position.route);
        }
        let trip = route_trips.and_then(|route| route.resolve(&position));
        let lat = position.lat.unwrap_or(f32::NAN);
        let lon = position.lon.unwrap_or(f32::NAN);
        if !position.vehicle_id.is_empty() && valid_coordinate(f64::from(lat), f64::from(lon)) {
            totals.add(trip.is_some());
            route_matches.add(trip.is_some());
        }
        buffer.push(RawFix {
            fetch,
            timestamp: position
                .vehicle_ts
                .map_or(f64::NAN, |ts| ts as f64 / 1_000.0),
            lat,
            lon,
            trip_id: trip.map(|trip| trip.id.as_bytes()),
            vehicle_id: Some(position.vehicle_id.as_bytes()),
            route_id: Some(position.route.as_bytes()),
            start_date: Some(date.as_bytes()),
            start_time: None,
            occupancy: -1,
            differential: false,
        });
    }
    if !route_id.is_empty() {
        by_route.entry(route_id).or_default().merge(route_matches);
    }
    Ok(totals)
}

fn gap_notes(archive: &Archive, today: &str, next: &str, until: i64) -> Vec<String> {
    let mut notes = Vec::new();
    let mut add = |day: &str, before: i64| {
        if let Some(record) = archive.dates.get(day) {
            for gap in &record.gaps {
                let start = chrono::DateTime::parse_from_str(&gap.start, "%Y-%m-%dT%H:%M%:z");
                if start.is_ok_and(|start| start.timestamp() < before) {
                    notes.push(format!("{} to {} · {}", gap.start, gap.end, gap.note));
                }
            }
        }
    };
    add(today, i64::MAX);
    add(next, until);
    if !archive.dates.contains_key(next) {
        notes.push(format!(
            "{next} was unavailable in the Positions archive revision. Service after midnight is incomplete."
        ));
    }
    notes
}

#[derive(Serialize)]
struct LineResult {
    available: bool,
    line: Option<CompactLine>,
}

#[derive(Default)]
struct LineDistances {
    index: HashMap<u32, i32>,
    meters: Vec<f32>,
}

impl LineDistances {
    fn index_of(&mut self, meters: f32) -> i32 {
        *self.index.entry(meters.to_bits()).or_insert_with(|| {
            let index = self.meters.len() as i32;
            self.meters.push(meters);
            index
        })
    }
}

#[derive(Serialize)]
struct CompactTrip(String, String, Option<i32>, Vec<i32>);

#[derive(Serialize)]
struct CompactLine {
    date: String,
    route: String,
    dir: u8,
    length_m: f32,
    stops: Vec<(f32, String)>,
    trips: Vec<CompactTrip>,
}

impl CompactLine {
    fn encode(line: StringLine, distances: &mut LineDistances) -> Self {
        let trips = line
            .trips
            .into_iter()
            .map(|trip| {
                debug_assert_eq!(trip.observed.len(), trip.scheduled.len());
                let mut points = Vec::with_capacity(trip.observed.len() * 3);
                let mut previous_time = 0;
                let mut previous_index = 0;
                // A stop passage produces parallel observed and scheduled points.
                // Share each distance and store changes to make gzip more effective.
                for ((observed, meters), (scheduled, scheduled_meters)) in
                    trip.observed.into_iter().zip(trip.scheduled)
                {
                    debug_assert_eq!(meters.to_bits(), scheduled_meters.to_bits());
                    let index = distances.index_of(meters);
                    points.extend([
                        scheduled - previous_time,
                        observed - scheduled,
                        index - previous_index,
                    ]);
                    previous_time = scheduled;
                    previous_index = index;
                }
                CompactTrip(trip.trip_id, trip.vehicle, trip.deviation_end_s, points)
            })
            .collect();
        Self {
            date: line.date,
            route: line.route,
            dir: line.dir,
            length_m: line.length_m,
            stops: line.stops,
            trips,
        }
    }
}

#[derive(Serialize)]
struct LineReport {
    version: u8,
    distances: Vec<f32>,
    directions: BTreeMap<u8, BTreeMap<String, LineResult>>,
}

#[derive(Serialize)]
struct RouteReport {
    route: RouteDetail,
    map: NetworkMap,
    lines: String,
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<(), Box<dyn Error>> {
    let mut writer = BufWriter::new(File::create(path)?);
    serde_json::to_writer(&mut writer, value)?;
    writer.flush()?;
    Ok(())
}

fn write_gzip_json(path: &Path, value: &impl Serialize) -> Result<(), Box<dyn Error>> {
    let file = File::create(path)?;
    let mut gzip = Command::new("gzip")
        .args(["-n", "-c"])
        .stdin(Stdio::piped())
        .stdout(file)
        .spawn()?;
    let written = (|| -> Result<(), Box<dyn Error>> {
        let stdin = gzip.stdin.take().ok_or("gzip stdin is unavailable")?;
        let mut writer = BufWriter::new(stdin);
        serde_json::to_writer(&mut writer, value)?;
        writer.flush()?;
        Ok(())
    })();
    if !gzip.wait()?.success() {
        return Err(format!("gzip failed for {}", path.display()).into());
    }
    written?;
    Ok(())
}

fn safe_route_id(id: &str) -> bool {
    !id.is_empty() && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
}

fn publish_snapshot(
    out: &Path,
    render: impl FnOnce(&Path) -> Result<(), Box<dyn Error>>,
) -> Result<(), Box<dyn Error>> {
    let parent = out
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let name = out
        .file_name()
        .ok_or("Snapshot output needs a directory name")?;
    match fs::symlink_metadata(out) {
        Ok(meta) if meta.is_dir() => {
            if !out.join("index.json").is_file() && fs::read_dir(out)?.next().is_some() {
                return Err(
                    format!("Snapshot output {} contains other files", out.display()).into(),
                );
            }
        }
        Ok(_) => {
            return Err(format!("Snapshot output {} is not a directory", out.display()).into());
        }
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    let sibling = |role: &str| {
        let mut file = std::ffi::OsString::from(".");
        file.push(name);
        file.push(format!("-{role}-{}-{stamp}", std::process::id()));
        parent.join(file)
    };
    let stage = sibling("staging");
    let previous = sibling("previous");
    fs::create_dir_all(parent)?;
    fs::create_dir(&stage)?;
    if let Err(error) = render(&stage) {
        let _ = fs::remove_dir_all(&stage);
        return Err(error);
    }

    // Keep the previous complete graph until the new files and their index exist.
    let had_previous = match fs::rename(out, &previous) {
        Ok(()) => true,
        Err(error) if error.kind() == ErrorKind::NotFound => false,
        Err(error) => return Err(error.into()),
    };
    if let Err(error) = fs::rename(&stage, out) {
        if had_previous && let Err(restore) = fs::rename(&previous, out) {
            return Err(format!(
                "Could not publish {}: {error}. The previous snapshot is at {}: {restore}",
                out.display(),
                previous.display(),
            )
            .into());
        }
        return Err(error.into());
    }
    if had_previous && let Err(error) = fs::remove_dir_all(&previous) {
        eprintln!(
            "Previous snapshot retained at {}: {error}",
            previous.display()
        );
    }
    Ok(())
}

fn export(
    out: &Path,
    library: &Library,
    archive: &Archive,
    dates: &[ServiceDate],
    matches: &BTreeMap<String, MatchCount>,
    route_matches: &BTreeMap<String, MatchCount>,
) -> Result<(), Box<dyn Error>> {
    let selection: Selection = serde_json::from_value(serde_json::json!({
        "dates": dates.iter().map(|date| date.0).collect::<Vec<_>>(),
        "mode": Mode::Bus,
    }))?;
    let merged = Merged::compute(library, selection);
    let mut overview = serde_json::to_value(report::overview(library, &merged))?;
    if let Some(days) = overview
        .get_mut("days")
        .and_then(serde_json::Value::as_array_mut)
    {
        for (day, date) in days.iter_mut().zip(&merged.dates) {
            let date = ServiceDate(*date).to_string();
            day["trip_match"] =
                serde_json::to_value(matches.get(&date).and_then(MatchCount::rate))?;
            day["method"] = "schedule".into();
        }
    }
    let scores = report::route_scores(library, &merged);
    let route_match: BTreeMap<&str, f64> = route_matches
        .iter()
        .filter_map(|(route, count)| count.rate().map(|rate| (route.as_str(), rate)))
        .collect();
    let archive_only_routes: BTreeMap<&str, u64> = route_matches
        .iter()
        .filter(|(id, count)| count.eligible > 0 && library.route_index(id).is_none())
        .map(|(id, count)| (id.as_str(), count.eligible))
        .collect();
    let mut notes = [
        "CTA bus positions are compared with Mobility Database’s September 16, 2026 GTFS archive, using its service calendar. Rail is excluded.",
        "The Positions archive has no trip IDs. A report is assigned only to a unique active GTFS trip with the same route and exact scheduled departure, corroborated by the pattern ID or by an exact headsign for alternate pattern IDs.",
        "Match percentages are shares of usable vehicle position reports on the requested service dates. Speeds and stop events use matched trips. Lower match rates and source outages can skew the service that is visible.",
        "The CTA timetable has no timepoint field. Route on-time rates use all scheduled stop passes that could be interpolated from GPS.",
        "The archive used approximately one-minute polling in October and 30-second polling in November. Days with documented capture gaps or reduced polling remain in the selection and are marked partial.",
    ]
    .map(str::to_owned)
    .to_vec();
    notes.extend(archive_only_routes.iter().map(|(id, reports)| {
        format!("Route {id} had {reports} usable reports in the Positions archive and no route in the pinned timetable. It has no scorecard metrics.")
    }));

    fs::create_dir_all(out.join("routes"))?;
    fs::create_dir_all(out.join("lines"))?;
    let mut details = BTreeMap::new();
    for score in &scores {
        let id = &score.id;
        if !safe_route_id(id) {
            return Err(format!("Unexpected CTA route ID {id:?}").into());
        }
        let route = report::route_detail(library, &merged, id)
            .ok_or_else(|| format!("Missing detail report for route {id}"))?;
        let mut lines = BTreeMap::new();
        let mut distances = LineDistances::default();
        for direction in &route.directions {
            let mut by_date = BTreeMap::new();
            for &date in &merged.dates {
                let line = report::string_line(library, &merged, id, direction.dir, date)
                    .map(|line| CompactLine::encode(line, &mut distances));
                by_date.insert(
                    ServiceDate(date).to_string(),
                    LineResult {
                        available: library.events.contains_key(&date),
                        line,
                    },
                );
            }
            lines.insert(direction.dir, by_date);
        }
        let line_path = format!("lines/{id}.json.gz");
        write_gzip_json(
            &out.join(&line_path),
            &LineReport {
                version: 1,
                distances: distances.meters,
                directions: lines,
            },
        )?;

        let path = format!("routes/{id}.json");
        let map = report::network_map(library, &merged, Some(id));
        write_json(
            &out.join(&path),
            &RouteReport {
                route,
                map,
                lines: line_path,
            },
        )?;
        details.insert(id, path);
    }

    write_json(
        &out.join("index.json"),
        &serde_json::json!({
            "version": 1,
            "requestedDates": dates.iter().map(ToString::to_string).collect::<Vec<_>>(),
            "overview": overview,
            "routes": scores,
            "details": details,
            "routeTripMatch": route_match,
            "archiveOnlyRoutes": archive_only_routes,
            "notes": notes,
            "sources": archive.sources,
        }),
    )
}

fn main() -> Result<(), Box<dyn Error>> {
    let mut args = env::args().skip(1);
    let usage = "usage: export_cta_snapshot <cache-dir> <output-dir> [YYYY-MM-DD ...]";
    let dir = PathBuf::from(args.next().ok_or(usage)?);
    let out = PathBuf::from(args.next().ok_or(usage)?);
    let subset: Vec<String> = args.collect();
    let archive: Archive = serde_json::from_reader(File::open(dir.join("coverage.json"))?)?;
    if archive.timezone != "America/Chicago" || archive.clock_samples.is_empty() {
        return Err("CTA coverage requires America/Chicago clock samples".into());
    }
    let clock = Clock::from_samples(archive.clock_samples.clone());
    let requested = if subset.is_empty() {
        &archive.requested_dates
    } else {
        &subset
    };
    let mut dates = requested
        .iter()
        .map(|date| ServiceDate::parse(date).ok_or_else(|| format!("Invalid service date {date}")))
        .collect::<Result<Vec<_>, _>>()?;
    dates.sort_unstable();
    dates.dedup();
    if dates.is_empty() {
        return Err("At least one CTA service date is required".into());
    }
    if let Some(date) = dates
        .iter()
        .find(|date| !archive.requested_dates.contains(&date.to_string()))
    {
        return Err(
            format!("Service date {date} is outside the prepared CTA weekday sample").into(),
        );
    }

    let started = Instant::now();
    let (schedule, headsigns) = cta_schedule::read(&dir.join("schedule"), "mdb-389:20260916")?;
    eprintln!(
        "Compiled CTA schedule: {} routes, {} trips, {} patterns in {:.1?}",
        schedule.routes.len(),
        schedule.trips.len(),
        schedule.patterns.len(),
        started.elapsed()
    );
    let mut library = Library::default();
    library.add_schedule(&schedule.meta());
    let mut matches = BTreeMap::new();
    let mut route_matches = BTreeMap::new();
    for &date in &dates {
        let started = Instant::now();
        let date_text = date.to_string();
        if !archive.dates.contains_key(&date_text) {
            return Err(format!("Missing Positions archive metadata for {date}").into());
        }
        let next = date.offset(1).ok_or("Date overflow")?.to_string();
        let origin = clock
            .service_origin(date)
            .ok_or("Invalid CTA service date")?;
        let until = origin + SERVICE_HOURS as i64 * 3600;
        let index = trip_index(&schedule, &headsigns, date);
        let mut buffer = RtBuffer::default();
        let mut counts = MatchCount::default();
        let positions = dir.join("positions");
        for archive_date in [&date_text, &next] {
            if archive.dates.contains_key(archive_date) {
                counts.merge(ingest(
                    &positions,
                    &date_text,
                    archive_date,
                    until,
                    &index,
                    &mut buffer,
                    &mut route_matches,
                )?);
            }
        }
        let notes = gap_notes(&archive, &date_text, &next, until);
        let mut result = process_day(
            &schedule,
            &mut buffer,
            date,
            &clock,
            &Coverage::complete(),
            &notes,
        )?;
        if !notes.is_empty() && result.cube.status == DayStatus::Complete {
            result.cube.status = DayStatus::Partial;
        }
        eprintln!(
            "{date}: {}/{} position reports matched, {} trips observed, {} stop events, {:?} in {:.1?}",
            counts.matched,
            counts.eligible,
            result.cube.quality.trips_observed,
            result.events.len(),
            result.cube.status,
            started.elapsed(),
        );
        let events = (!result.events.is_empty()).then_some(result.events);
        library.add_day(result.cube, events)?;
        matches.insert(date_text, counts);
    }

    let started = Instant::now();
    publish_snapshot(&out, |stage| {
        export(stage, &library, &archive, &dates, &matches, &route_matches)
    })?;
    eprintln!(
        "Exported {} service days in {:.1?}",
        dates.len(),
        started.elapsed()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use transit_core::report::StringLineTrip;

    #[test]
    fn conflicting_known_patterns_never_fall_back_to_headsign() {
        let trip = Trip {
            id: "scheduled".into(),
            route: 0,
            service: 0,
            pattern: 0,
            times_start: 0,
            has_timepoints: false,
        };
        let mut names = Headsigns::default();
        names.record(1, "79th");
        let mut route = RouteTrips {
            by_start: HashMap::from([(
                28_800,
                vec![Candidate {
                    trip: &trip,
                    pid: pattern_pid("68201234"),
                    headsigns: Some(&names),
                }],
            )]),
            pids: HashSet::from([1234, 5678]),
        };
        let mut position = Position {
            ts: 0,
            vehicle_ts: None,
            route: "49",
            pid: "5678",
            vehicle_id: "8001",
            destination: "79th",
            lat: None,
            lon: None,
            sched_start_sec: Some(28_800),
            sched_start_date: "2026-11-09",
        };
        assert!(route.resolve(&position).is_none());
        position.pid = "01234";
        assert_eq!(route.resolve(&position).unwrap().id, "scheduled");
        position.pid = "502468";
        assert_eq!(route.resolve(&position).unwrap().id, "scheduled");
        let candidates = route.by_start.get_mut(&28_800).unwrap();
        candidates.push(candidates[0]);
        assert!(route.resolve(&position).is_none(), "two headsign matches");
        position.pid = "1234";
        assert!(route.resolve(&position).is_none(), "two PID matches");
        position.sched_start_sec = Some(28_801);
        assert!(route.resolve(&position).is_none(), "one second off");
    }

    #[test]
    fn compact_stop_passes_preserve_times_distances_and_shared_indexes() {
        let line = StringLine {
            date: "2026-11-09".into(),
            route: "9".into(),
            dir: 1,
            length_m: 350.125,
            stops: Vec::new(),
            trips: vec![StringLineTrip {
                trip_id: "trip".into(),
                vehicle: "vehicle".into(),
                deviation_end_s: Some(30),
                observed: vec![(100, 45.875), (230, 350.125), (240, 350.125)],
                scheduled: vec![(105, 45.875), (200, 350.125), (210, 350.125)],
            }],
        };
        let mut distances = LineDistances::default();
        assert_eq!(distances.index_of(350.125), 0);
        let report = CompactLine::encode(line, &mut distances);
        assert_eq!(distances.meters, [350.125, 45.875]);
        assert_eq!(report.trips[0].3, [105, -5, 1, 95, 30, -1, 10, 30, 0]);
    }

    #[test]
    fn failed_rebuild_keeps_the_previous_snapshot() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            env::temp_dir().join(format!("cta-snapshot-test-{}-{stamp}", std::process::id()));
        let out = root.join("snapshot");
        publish_snapshot(&out, |stage| {
            fs::write(stage.join("index.json"), "previous")?;
            Ok(())
        })
        .unwrap();
        let failed = publish_snapshot(&out, |stage| {
            fs::write(stage.join("index.json"), "unfinished")?;
            Err("simulated export failure".into())
        });
        assert!(failed.is_err());
        assert_eq!(
            fs::read_to_string(out.join("index.json")).unwrap(),
            "previous"
        );
        publish_snapshot(&out, |stage| {
            fs::write(stage.join("index.json"), "replacement")?;
            Ok(())
        })
        .unwrap();
        assert_eq!(
            fs::read_to_string(out.join("index.json")).unwrap(),
            "replacement"
        );
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_dir_all(root).unwrap();
    }
}
