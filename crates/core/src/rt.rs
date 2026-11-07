//! Realtime vehicle positions buffered between archive files.
//!
//! A service day spans two UTC archive files, so fixes wait here until every
//! file covering a day has been read. IDs are interned to keep each fix compact
//! on feeds that report millions of positions a day.

use rustc_hash::FxHashMap;

/// A string interner over raw bytes from Arrow columns.
#[derive(Default)]
pub struct Interner {
    lookup: FxHashMap<Box<[u8]>, u32>,
    values: Vec<Box<str>>,
}

impl Interner {
    pub fn intern(&mut self, value: &[u8]) -> u32 {
        if let Some(index) = self.lookup.get(value) {
            return *index;
        }
        let index = self.values.len() as u32;
        self.lookup.insert(value.into(), index);
        self.values.push(String::from_utf8_lossy(value).into());
        index
    }

    pub fn get(&self, index: u32) -> &str {
        self.values.get(index as usize).map_or("", AsRef::as_ref)
    }

    pub fn len(&self) -> usize {
        self.values.len()
    }

    pub fn is_empty(&self) -> bool {
        self.values.is_empty()
    }
}

/// The trip descriptor as the feed reported it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Descriptor {
    pub trip: u32,
    pub route: u32,
    pub start_date: u32,
    pub start_time: i32,
}

const MAX_REPORT_AGE_S: f64 = 86_400.0;
const MAX_REPORT_AHEAD_S: f64 = 3600.0;

pub const NO_START_DATE: u32 = 0;
pub const NO_START_TIME: i32 = i32::MIN;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Fix {
    pub time: u32,
    pub lat: f32,
    pub lon: f32,
    pub descriptor: u32,
    pub vehicle: u32,
    pub occupancy: i8,
    pub approximate: bool,
}

#[derive(Clone, Copy)]
enum Ingestion {
    Trip,
    Position { approximate: bool },
}

/// One row of realtime input, already decoded from its source columns.
#[derive(Clone, Copy, Debug)]
pub struct RawFix<'a> {
    pub fetch: f64,
    pub timestamp: f64,
    pub lat: f32,
    pub lon: f32,
    pub trip_id: Option<&'a [u8]>,
    pub vehicle_id: Option<&'a [u8]>,
    pub route_id: Option<&'a [u8]>,
    pub start_date: Option<&'a [u8]>,
    pub start_time: Option<&'a [u8]>,
    pub occupancy: i8,
    pub differential: bool,
}

/// Counts for the quality funnel, kept per UTC hour so they can be assigned to
/// the service day that owns each hour.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct HourCounts {
    pub rows: u32,
    pub no_trip: u32,
    pub no_vehicle: u32,
    pub bad_coordinate: u32,
    pub fallback_time: u32,
    pub differential: u32,
}

/// Fixes waiting for their service day to be complete.
#[derive(Default)]
pub struct RtBuffer {
    pub trips: Interner,
    pub routes: Interner,
    pub vehicles: Interner,
    pub descriptors: Vec<Descriptor>,
    descriptor_ids: FxHashMap<Descriptor, u32>,
    pub fixes: Vec<Fix>,
    pub polls: Vec<u32>,
    pub hours: FxHashMap<u32, HourCounts>,
    last_poll: u32,
}

impl RtBuffer {
    /// Adds one row, recording why it was unusable when it is. Rows without a
    /// trip are out-of-service moves and layovers, which the metrics exclude.
    pub fn push(&mut self, raw: RawFix<'_>) {
        self.push_with_policy(raw, Ingestion::Trip);
    }

    /// Retains observations from a position feed, including station estimates
    /// that break a trajectory without contributing to its speed.
    pub fn push_position(&mut self, raw: RawFix<'_>, approximate: bool) {
        self.push_with_policy(raw, Ingestion::Position { approximate });
    }

    fn push_with_policy(&mut self, raw: RawFix<'_>, ingestion: Ingestion) {
        if !raw.fetch.is_finite() || raw.fetch <= 0.0 {
            return;
        }
        let fetch = raw.fetch as u32;
        let hour = fetch / 3600;
        let counts = self.hours.entry(hour).or_default();
        counts.rows += 1;
        if fetch != self.last_poll {
            self.polls.push(fetch);
            self.last_poll = fetch;
        }
        if raw.differential {
            counts.differential += 1;
        }
        let Some(vehicle_id) = raw.vehicle_id.filter(|v| !v.is_empty()) else {
            counts.no_vehicle += 1;
            return;
        };
        let approximate = matches!(ingestion, Ingestion::Position { approximate: true });
        if !crate::geo::valid_coordinate(f64::from(raw.lat), f64::from(raw.lon)) {
            counts.bad_coordinate += 1;
            if !approximate {
                return;
            }
        }
        let trip_id = raw.trip_id.unwrap_or_default();
        if trip_id.is_empty() {
            counts.no_trip += 1;
            if matches!(ingestion, Ingestion::Trip) {
                return;
            }
        }
        // A report time a day from when it was fetched is bad data, such as milliseconds.
        let plausible = raw.timestamp.is_finite()
            && raw.timestamp > raw.fetch - MAX_REPORT_AGE_S
            && raw.timestamp < raw.fetch + MAX_REPORT_AHEAD_S;
        let time = if plausible {
            raw.timestamp as u32
        } else {
            counts.fallback_time += 1;
            fetch
        };
        let descriptor = Descriptor {
            trip: self.trips.intern(trip_id),
            route: self.routes.intern(raw.route_id.unwrap_or_default()),
            start_date: raw
                .start_date
                .and_then(parse_compact_date)
                .unwrap_or(NO_START_DATE),
            start_time: raw
                .start_time
                .and_then(|t| std::str::from_utf8(t).ok())
                .and_then(crate::schedule::parse_gtfs_time)
                .unwrap_or(NO_START_TIME),
        };
        let descriptor = match self.descriptor_ids.get(&descriptor) {
            Some(index) => *index,
            None => {
                let index = self.descriptors.len() as u32;
                self.descriptor_ids.insert(descriptor, index);
                self.descriptors.push(descriptor);
                index
            }
        };
        let vehicle = self.vehicles.intern(vehicle_id);
        self.fixes.push(Fix {
            time,
            lat: raw.lat,
            lon: raw.lon,
            descriptor,
            vehicle,
            occupancy: raw.occupancy,
            approximate,
        });
    }

    /// Drops everything strictly before `epoch`, once no later day can need it.
    pub fn evict_before(&mut self, epoch: i64) {
        let cutoff = epoch.max(0) as u32;
        self.fixes.retain(|fix| fix.time >= cutoff);
        self.polls.retain(|poll| *poll >= cutoff);
        self.hours
            .retain(|hour, _| i64::from(*hour) * 3600 >= i64::from(cutoff) - 3600);
    }
}

fn parse_compact_date(value: &[u8]) -> Option<u32> {
    let text = std::str::from_utf8(value).ok()?;
    crate::time::ServiceDate::parse(text).map(|date| date.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw<'a>() -> RawFix<'a> {
        RawFix {
            fetch: 1_793_836_800.5,
            timestamp: 1_793_836_790.0,
            lat: 43.0,
            lon: -89.0,
            trip_id: Some(b"T1"),
            vehicle_id: Some(b"V1"),
            route_id: Some(b"R1"),
            start_date: Some(b"20261105"),
            start_time: Some(b"07:00:00"),
            occupancy: -1,
            differential: false,
        }
    }

    #[test]
    fn interner_returns_stable_indexes_and_values() {
        let mut interner = Interner::default();
        let a = interner.intern(b"x");
        let b = interner.intern(b"y");
        assert_ne!(a, b);
        assert_eq!(interner.intern(b"x"), a);
        assert_eq!(interner.get(b), "y");
    }

    #[test]
    fn rows_without_a_trip_or_with_bad_coordinates_are_counted_not_kept() {
        let mut buffer = RtBuffer::default();
        buffer.push(raw());
        buffer.push(RawFix {
            trip_id: None,
            ..raw()
        });
        buffer.push(RawFix {
            trip_id: Some(b""),
            ..raw()
        });
        buffer.push(RawFix {
            lat: 0.0,
            lon: 0.0,
            ..raw()
        });
        buffer.push(RawFix {
            vehicle_id: None,
            ..raw()
        });
        assert_eq!(buffer.fixes.len(), 1);
        let counts = buffer.hours.values().next().unwrap();
        assert_eq!(counts.rows, 5);
        assert_eq!(counts.no_trip, 2);
        assert_eq!(counts.bad_coordinate, 1);
        assert_eq!(counts.no_vehicle, 1);
    }

    #[test]
    fn a_missing_vehicle_timestamp_falls_back_to_fetch_time_and_is_recorded() {
        let mut buffer = RtBuffer::default();
        buffer.push(RawFix {
            timestamp: 0.0,
            ..raw()
        });
        assert_eq!(buffer.fixes[0].time, 1_793_836_800);
        assert_eq!(buffer.hours.values().next().unwrap().fallback_time, 1);
    }

    #[test]
    fn an_implausible_report_time_falls_back_and_is_recorded() {
        let mut buffer = RtBuffer::default();
        buffer.push(RawFix {
            timestamp: 1_793_836_800_000.0, // milliseconds
            ..raw()
        });
        assert_eq!(buffer.fixes[0].time, 1_793_836_800);
        assert_eq!(buffer.hours.values().next().unwrap().fallback_time, 1);
    }

    #[test]
    fn repeated_polls_are_counted_once() {
        let mut buffer = RtBuffer::default();
        buffer.push(raw());
        buffer.push(raw());
        buffer.push(RawFix {
            fetch: 1_793_836_820.0,
            ..raw()
        });
        assert_eq!(buffer.polls.len(), 2);
    }

    #[test]
    fn descriptors_keep_the_reported_start_date_and_time() {
        let mut buffer = RtBuffer::default();
        buffer.push(raw());
        let descriptor = buffer.descriptors[0];
        assert_eq!(descriptor.start_date, 20261105);
        assert_eq!(descriptor.start_time, 7 * 3600);
    }

    #[test]
    fn eviction_keeps_fixes_a_later_day_still_needs() {
        let mut buffer = RtBuffer::default();
        buffer.push(raw());
        buffer.evict_before(1_793_836_700);
        assert_eq!(buffer.fixes.len(), 1);
        buffer.evict_before(1_793_836_900);
        assert!(buffer.fixes.is_empty());
    }
}
