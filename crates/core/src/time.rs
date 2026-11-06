//! Service dates and the local clock.
//!
//! GTFS measures scheduled times from "noon minus twelve hours" on the service
//! date, so a trip can run past 24:00:00 and a daylight-saving day still lines
//! up. Everything downstream works in seconds from that origin.

use chrono::{Datelike, NaiveDate, Weekday};
use serde::{Deserialize, Serialize};
use std::fmt;

/// A GTFS service date stored as `YYYYMMDD`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct ServiceDate(pub u32);

impl ServiceDate {
    /// Parses `YYYY-MM-DD` or `YYYYMMDD`, rejecting impossible calendar dates.
    pub fn parse(value: &str) -> Option<Self> {
        let digits: String = value.chars().filter(|c| *c != '-').collect();
        if digits.len() != 8 || !digits.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let number: u32 = digits.parse().ok()?;
        let date = Self(number);
        date.to_naive().map(|_| date)
    }

    pub fn to_naive(self) -> Option<NaiveDate> {
        NaiveDate::from_ymd_opt((self.0 / 10_000) as i32, self.0 / 100 % 100, self.0 % 100)
    }

    pub fn from_naive(date: NaiveDate) -> Self {
        Self(date.year() as u32 * 10_000 + date.month() * 100 + date.day())
    }

    pub fn weekday(self) -> Option<Weekday> {
        self.to_naive().map(|d| d.weekday())
    }

    /// The date `days` later (or earlier when negative).
    pub fn offset(self, days: i64) -> Option<Self> {
        let date = self.to_naive()?;
        let moved = date.checked_add_signed(chrono::TimeDelta::try_days(days)?)?;
        Some(Self::from_naive(moved))
    }

    /// Epoch seconds of 00:00:00 UTC on this calendar date.
    pub fn utc_midnight(self) -> Option<i64> {
        Some(self.to_naive()?.and_hms_opt(0, 0, 0)?.and_utc().timestamp())
    }

    pub fn from_epoch_utc(epoch: i64) -> Option<Self> {
        chrono::DateTime::from_timestamp(epoch, 0).map(|t| Self::from_naive(t.date_naive()))
    }
}

impl fmt::Display for ServiceDate {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{:04}-{:02}-{:02}",
            self.0 / 10_000,
            self.0 / 100 % 100,
            self.0 % 100
        )
    }
}

/// UTC-offset lookup for one agency time zone.
///
/// The browser builds this from `Intl.DateTimeFormat`, which keeps a full time
/// zone database out of the WASM binary. Offsets apply from their start time
/// until the next entry.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Clock {
    transitions: Vec<(i64, i32)>,
}

impl Clock {
    /// A clock with one offset for all time; used by tests and as a fallback.
    pub fn fixed(offset_seconds: i32) -> Self {
        Self {
            transitions: vec![(i64::MIN, offset_seconds)],
        }
    }

    /// Builds from `(epoch, offset)` samples in any order. Neighbouring samples
    /// with equal offsets collapse, so hourly sampling stays compact.
    pub fn from_samples(mut samples: Vec<(i64, i32)>) -> Self {
        samples.sort_unstable();
        let mut transitions: Vec<(i64, i32)> = Vec::new();
        for (epoch, offset) in samples {
            match transitions.last() {
                Some(&(_, previous)) if previous == offset => {}
                Some(_) => transitions.push((epoch, offset)),
                None => transitions.push((i64::MIN, offset)),
            }
        }
        Self { transitions }
    }

    pub fn offset_at(&self, epoch: i64) -> i32 {
        let index = self.transitions.partition_point(|(from, _)| *from <= epoch);
        index
            .checked_sub(1)
            .and_then(|i| self.transitions.get(i))
            .map_or(0, |(_, offset)| *offset)
    }

    /// Epoch of the GTFS time origin for `date`: local noon minus twelve hours.
    pub fn service_origin(&self, date: ServiceDate) -> Option<i64> {
        let noon_utc = date.utc_midnight()? + 43_200;
        // Two passes settle the offset when noon falls beside a transition.
        let first = noon_utc - i64::from(self.offset_at(noon_utc));
        let noon = noon_utc - i64::from(self.offset_at(first));
        Some(noon - 43_200)
    }

    /// The local calendar date of an instant.
    pub fn local_date(&self, epoch: i64) -> Option<ServiceDate> {
        ServiceDate::from_epoch_utc(epoch + i64::from(self.offset_at(epoch)))
    }
}

/// Hour buckets run past 24 so overnight service stays on its service date.
pub const SERVICE_HOURS: usize = 30;

/// The reporting bucket for a time in seconds from the GTFS origin.
pub fn service_hour(seconds_from_origin: i64) -> usize {
    (seconds_from_origin.div_euclid(3600)).clamp(0, SERVICE_HOURS as i64 - 1) as usize
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_both_date_forms_and_rejects_impossible_dates() {
        assert_eq!(
            ServiceDate::parse("2026-11-05"),
            Some(ServiceDate(20261105))
        );
        assert_eq!(ServiceDate::parse("20261105"), Some(ServiceDate(20261105)));
        assert_eq!(ServiceDate::parse("2026-02-30"), None);
        assert_eq!(ServiceDate::parse("2026-1-5"), None);
        assert_eq!(ServiceDate::parse(""), None);
    }

    #[test]
    fn offset_steps_across_months() {
        let date = ServiceDate(20261031);
        assert_eq!(date.offset(1), Some(ServiceDate(20261101)));
        assert_eq!(
            ServiceDate(20270101).offset(-1),
            Some(ServiceDate(20261231))
        );
    }

    #[test]
    fn service_origin_is_noon_minus_twelve_on_a_daylight_saving_day() {
        // US Central left daylight time at 2026-11-01 07:00 UTC.
        let change = ServiceDate(20261101).utc_midnight().unwrap() + 7 * 3600;
        let clock = Clock::from_samples(vec![
            (change - 86_400, -5 * 3600),
            (change, -6 * 3600),
            (change + 86_400, -6 * 3600),
        ]);
        let origin = clock.service_origin(ServiceDate(20261101)).unwrap();
        // Noon CST is 18:00 UTC; twelve hours earlier is 06:00 UTC, which is
        // 01:00 CDT. The wall clock reads 00:00 only on an ordinary day.
        assert_eq!(
            origin,
            ServiceDate(20261101).utc_midnight().unwrap() + 6 * 3600
        );
    }

    #[test]
    fn local_date_uses_the_offset_in_force() {
        let clock = Clock::fixed(-6 * 3600);
        let late_evening_utc_next_day = ServiceDate(20261106).utc_midnight().unwrap() + 3600;
        assert_eq!(
            clock.local_date(late_evening_utc_next_day),
            Some(ServiceDate(20261105))
        );
    }

    #[test]
    fn hour_buckets_clamp_overnight_service_without_wrapping() {
        assert_eq!(service_hour(25 * 3600), 25);
        assert_eq!(service_hour(99 * 3600), SERVICE_HOURS - 1);
        assert_eq!(service_hour(-30), 0);
    }
}
