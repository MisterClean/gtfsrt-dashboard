use std::{collections::HashMap, error::Error, fs::File, path::Path};

use csv::StringRecord;
use transit_core::schedule::{RouteMeta, Schedule, ScheduleBuilder, StopMeta, parse_gtfs_time};

pub fn open(dir: &Path, table: &str) -> Result<csv::Reader<File>, csv::Error> {
    csv::Reader::from_path(dir.join(format!("{table}.csv")))
}

fn read_table(dir: &Path, table: &str, mut add: impl FnMut(&Fields<'_>)) -> Result<(), csv::Error> {
    let mut reader = open(dir, table)?;
    let headers = reader.headers()?.clone();
    let columns: HashMap<&str, usize> = headers.iter().enumerate().map(|(i, h)| (h, i)).collect();
    let mut row = StringRecord::new();
    while reader.read_record(&mut row)? {
        add(&Fields {
            row: &row,
            columns: &columns,
        });
    }
    Ok(())
}

struct Fields<'a> {
    row: &'a StringRecord,
    columns: &'a HashMap<&'a str, usize>,
}

impl Fields<'_> {
    fn get(&self, field: &str) -> &str {
        self.columns
            .get(field)
            .and_then(|index| self.row.get(*index))
            .unwrap_or_default()
    }
}

#[derive(Default)]
pub struct Headsigns {
    first: Option<(i32, String)>,
    last: Option<(i32, String)>,
}

impl Headsigns {
    pub(super) fn record(&mut self, sequence: i32, headsign: &str) {
        if headsign.is_empty() {
            return;
        }
        if self.first.as_ref().is_none_or(|(i, _)| sequence < *i) {
            self.first = Some((sequence, headsign.to_owned()));
        }
        if self.last.as_ref().is_none_or(|(i, _)| sequence > *i) {
            self.last = Some((sequence, headsign.to_owned()));
        }
    }

    fn destination(&self) -> Option<&str> {
        self.last.as_ref().map(|(_, name)| name.as_str())
    }

    pub fn includes(&self, destination: &str) -> bool {
        [self.first.as_ref(), self.last.as_ref()]
            .into_iter()
            .flatten()
            .any(|(_, name)| name.trim().eq_ignore_ascii_case(destination.trim()))
    }
}

pub fn read(
    dir: &Path,
    digest: &str,
) -> Result<(Schedule, HashMap<String, Headsigns>), Box<dyn Error>> {
    let mut builder = ScheduleBuilder::new(digest);
    read_table(dir, "agency", |row| {
        builder.set_timezone(row.get("agency_timezone"));
    })?;
    read_table(dir, "routes", |row| {
        builder.add_route(RouteMeta {
            id: row.get("route_id").to_owned(),
            short_name: row.get("route_short_name").to_owned(),
            long_name: row.get("route_long_name").to_owned(),
            route_type: row.get("route_type").parse().ok(),
            color: row.get("route_color").to_owned(),
            text_color: row.get("route_text_color").to_owned(),
        });
    })?;
    read_table(dir, "stops", |row| {
        builder.add_stop(StopMeta {
            id: row.get("stop_id").to_owned(),
            code: row.get("stop_code").to_owned(),
            name: row.get("stop_name").to_owned(),
            lat: row.get("stop_lat").parse().unwrap_or(f64::NAN),
            lon: row.get("stop_lon").parse().unwrap_or(f64::NAN),
        });
    })?;
    read_table(dir, "shapes", |row| {
        builder.add_shape_point(
            row.get("shape_id"),
            row.get("shape_pt_sequence").parse().unwrap_or(0),
            row.get("shape_pt_lat").parse().unwrap_or(f64::NAN),
            row.get("shape_pt_lon").parse().unwrap_or(f64::NAN),
        );
    })?;
    read_table(dir, "calendar", |row| {
        let weekdays = [
            "monday",
            "tuesday",
            "wednesday",
            "thursday",
            "friday",
            "saturday",
            "sunday",
        ];
        builder.add_calendar(
            row.get("service_id"),
            weekdays.map(|day| row.get(day) == "1"),
            row.get("start_date").parse().unwrap_or(0),
            row.get("end_date").parse().unwrap_or(0),
        );
    })?;
    read_table(dir, "calendar_dates", |row| {
        builder.add_calendar_date(
            row.get("service_id"),
            row.get("date").parse().unwrap_or(0),
            row.get("exception_type").parse().unwrap_or(0),
        );
    })?;
    read_table(dir, "trips", |row| {
        let shape = row.get("shape_id");
        builder.add_trip(
            row.get("trip_id"),
            row.get("route_id"),
            row.get("service_id"),
            row.get("direction_id").parse().ok(),
            (!shape.is_empty()).then_some(shape),
            row.get("direction"),
        );
    })?;
    let mut headsigns: HashMap<String, Headsigns> = HashMap::new();
    read_table(dir, "stop_times", |row| {
        let id = row.get("trip_id");
        let sequence = row.get("stop_sequence").parse().unwrap_or(0);
        let headsign = row.get("stop_headsign");
        if !headsign.is_empty() {
            if let Some(existing) = headsigns.get_mut(id) {
                existing.record(sequence, headsign);
            } else {
                let mut entry = Headsigns::default();
                entry.record(sequence, headsign);
                headsigns.insert(id.to_owned(), entry);
            }
        }
        builder.add_stop_time(
            id,
            row.get("stop_id"),
            sequence,
            parse_gtfs_time(row.get("arrival_time")),
            parse_gtfs_time(row.get("departure_time")),
            match row.get("timepoint") {
                "1" => Some(true),
                "0" => Some(false),
                _ => None,
            },
        );
    })?;

    let mut schedule = builder.build()?;
    let mut named = vec![false; schedule.patterns.len()];
    for trip in &schedule.trips {
        let index = trip.pattern as usize;
        if !named[index]
            && let Some(destination) = headsigns.get(&trip.id).and_then(Headsigns::destination)
        {
            let direction = &mut schedule.patterns[index].headsign;
            if direction.is_empty() {
                *direction = destination.to_owned();
            } else {
                *direction = format!("{direction} · {destination}");
            }
            named[index] = true;
        }
    }
    Ok((schedule, headsigns))
}
