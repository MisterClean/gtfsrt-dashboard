//! Decides which archive objects a request needs before anything is downloaded.

use crate::time::{Clock, SERVICE_HOURS, ServiceDate};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const ARCHIVE: &str = "https://storage.googleapis.com/parquet.gtfsrt.io";
/// Upper limit on days in one analysis. Each day is processed and freed before
/// the next, so this bounds waiting time rather than memory.
pub const MAX_DAYS: usize = 62;

/// Feed keys come from the public catalog, so check them before building URLs.
pub fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 2048
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// One UTC archive object, and the span of it that the requested days need.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct PlannedFile {
    pub utc_date: String,
    pub url: String,
    pub alias: String,
    /// Epoch seconds. Rows outside this span are skipped through row-group
    /// statistics, so most of the object's data pages are never fetched.
    pub window_start: i64,
    pub window_end: i64,
    /// Service dates whose data is complete once this file has been read.
    pub completes: Vec<u32>,
    /// The end of this object, used to detect days cut off by the archive edge.
    pub ends_at: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ReadPlan {
    pub files: Vec<PlannedFile>,
    pub dates: Vec<u32>,
}

/// Works out the UTC objects covering a set of service dates. A service day
/// overlaps two UTC days in most time zones, so five consecutive weekdays take
/// six objects, and each object is read only once.
pub fn plan_read(
    feed_key: &str,
    dates: &[u32],
    clock: &Clock,
    archive_max: Option<ServiceDate>,
) -> Result<ReadPlan, String> {
    if !valid_key(feed_key) {
        return Err("This feed key is not valid.".to_owned());
    }
    if dates.is_empty() {
        return Err("Choose at least one service day.".to_owned());
    }
    if dates.len() > MAX_DAYS {
        return Err(format!("Choose at most {MAX_DAYS} service days at a time."));
    }
    let mut sorted: Vec<u32> = dates.to_vec();
    sorted.sort_unstable();
    sorted.dedup();

    let mut files: BTreeMap<ServiceDate, (i64, i64, Vec<u32>)> = BTreeMap::new();
    for date in &sorted {
        let date = ServiceDate::parse(&date.to_string())
            .ok_or_else(|| format!("{date} is not a valid service date."))?;
        let origin = clock
            .service_origin(date)
            .ok_or_else(|| format!("{date} is outside the supported calendar."))?;
        let (start, end) = (origin, origin + SERVICE_HOURS as i64 * 3600);
        let first = ServiceDate::from_epoch_utc(start)
            .ok_or_else(|| format!("{date} is outside the supported calendar."))?;
        let last = ServiceDate::from_epoch_utc(end - 1)
            .ok_or_else(|| format!("{date} is outside the supported calendar."))?;
        let mut current = first;
        let mut final_file = first;
        loop {
            if archive_max.is_some_and(|max| current > max) {
                break;
            }
            let entry = files.entry(current).or_insert((start, end, Vec::new()));
            entry.0 = entry.0.min(start);
            entry.1 = entry.1.max(end);
            final_file = current;
            if current >= last {
                break;
            }
            current = current
                .offset(1)
                .ok_or_else(|| format!("{date} is outside the supported calendar."))?;
        }
        if let Some(entry) = files.get_mut(&final_file) {
            entry.2.push(date.0);
        }
    }

    let mut planned = Vec::with_capacity(files.len());
    for (index, (utc, (start, end, completes))) in files.into_iter().enumerate() {
        let utc_date = utc.to_string();
        let midnight = utc
            .utc_midnight()
            .ok_or_else(|| format!("{utc} is outside the supported calendar."))?;
        planned.push(PlannedFile {
            url: format!(
                "{ARCHIVE}/vehicle_positions/date={utc_date}/base64url={feed_key}/data.parquet"
            ),
            alias: format!("rt_{index}.parquet"),
            utc_date,
            window_start: start.max(midnight),
            window_end: end.min(midnight + 86_400),
            completes,
            ends_at: midnight + 86_400,
        });
    }
    Ok(ReadPlan {
        files: planned,
        dates: sorted,
    })
}

/// A schedule version from the archive's `schedules.json`.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct ScheduleVersion {
    #[serde(rename = "_feed_digest")]
    pub digest: String,
    pub date_retrieved: String,
    pub feed_start_date: Option<String>,
    pub feed_end_date: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct ScheduleCatalog {
    pub base64url: String,
    pub schedule_url: String,
    pub versions: Vec<ScheduleVersion>,
}

/// The schedule tables to use for one service date, possibly from several
/// sources when an agency publishes more than one.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct ScheduleChoice {
    /// Identifies the combination, for caching and for labelling results.
    pub key: String,
    pub bases: Vec<String>,
    pub retrieved: Vec<String>,
    /// Every version chosen was published on or before the service date.
    pub published_before: bool,
}

fn valid_digest(digest: &str) -> bool {
    digest
        .strip_prefix("v1:")
        .is_some_and(|hash| hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// Picks the version in force on `date`: the most recently retrieved one whose
/// advertised dates cover the day and which was already published. When the
/// archive only captured a covering version later, that one is used and flagged.
/// Returns `None` if any source lacks a covering version.
pub fn choose_schedule(
    schedule_urls: &[String],
    catalogs: &[ScheduleCatalog],
    date: ServiceDate,
) -> Option<ScheduleChoice> {
    if schedule_urls.is_empty() {
        return None;
    }
    let compact = date.0.to_string();
    let iso = date.to_string();
    let mut key = Vec::new();
    let mut bases = Vec::new();
    let mut retrieved = Vec::new();
    let mut published_before = true;
    for url in schedule_urls {
        let catalog = catalogs
            .iter()
            .find(|c| &c.schedule_url == url && valid_key(&c.base64url))?;
        let covering: Vec<&ScheduleVersion> = catalog
            .versions
            .iter()
            .filter(|version| {
                valid_digest(&version.digest)
                    && version
                        .feed_start_date
                        .as_deref()
                        .is_none_or(|start| start <= compact.as_str())
                    && version
                        .feed_end_date
                        .as_deref()
                        .is_none_or(|end| end >= compact.as_str())
            })
            .collect();
        let before = covering
            .iter()
            .copied()
            .filter(|v| {
                v.date_retrieved
                    .get(..10)
                    .is_some_and(|r| r <= iso.as_str())
            })
            .max_by_key(|v| &v.date_retrieved);
        let version = match before {
            Some(version) => version,
            None => {
                published_before = false;
                covering.iter().copied().min_by_key(|v| &v.date_retrieved)?
            }
        };
        key.push(version.digest.clone());
        bases.push(format!(
            "{ARCHIVE}/schedules/base64url={}/_feed_digest={}",
            catalog.base64url, version.digest
        ));
        retrieved.push(version.date_retrieved.clone());
    }
    Some(ScheduleChoice {
        key: key.join("+"),
        bases,
        retrieved,
        published_before,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn central() -> Clock {
        Clock::fixed(-6 * 3600)
    }

    #[test]
    fn one_service_day_reads_the_two_utc_objects_it_overlaps() {
        let plan = plan_read("abc", &[20261104], &central(), None).unwrap();
        let dates: Vec<&str> = plan.files.iter().map(|f| f.utc_date.as_str()).collect();
        assert_eq!(dates, ["2026-11-04", "2026-11-05"]);
        assert_eq!(plan.files[1].completes, vec![20261104]);
        assert!(plan.files[0].completes.is_empty());
    }

    #[test]
    fn consecutive_days_share_objects_so_each_is_read_once() {
        let days = [20261102, 20261103, 20261104, 20261105, 20261106];
        let plan = plan_read("abc", &days, &central(), None).unwrap();
        assert_eq!(plan.files.len(), 6);
        let completes: Vec<u32> = plan
            .files
            .iter()
            .flat_map(|f| f.completes.clone())
            .collect();
        assert_eq!(completes, days);
    }

    #[test]
    fn scattered_days_only_read_the_objects_they_need() {
        let plan = plan_read("abc", &[20261102, 20261105], &central(), None).unwrap();
        assert_eq!(plan.files.len(), 4);
    }

    #[test]
    fn the_read_window_skips_hours_no_requested_day_needs() {
        let plan = plan_read("abc", &[20261104], &central(), None).unwrap();
        let origin = central().service_origin(ServiceDate(20261104)).unwrap();
        assert_eq!(plan.files[0].window_start, origin);
        assert_eq!(plan.files[1].window_end, origin + 30 * 3600);
    }

    #[test]
    fn days_at_the_edge_of_the_archive_still_complete_with_what_exists() {
        let plan = plan_read("abc", &[20261105], &central(), Some(ServiceDate(20261105))).unwrap();
        assert_eq!(plan.files.len(), 1);
        assert_eq!(plan.files[0].completes, vec![20261105]);
    }

    #[test]
    fn rejects_bad_keys_and_impossible_dates_and_oversized_requests() {
        assert!(plan_read("../other?sql='", &[20261104], &central(), None).is_err());
        assert!(plan_read("abc", &[], &central(), None).is_err());
        assert!(plan_read("abc", &[20260230], &central(), None).is_err());
        let many: Vec<u32> = (0..70).map(|i| 20260101 + i).collect();
        assert!(plan_read("abc", &many, &central(), None).is_err());
    }

    fn version(
        retrieved: &str,
        start: Option<&str>,
        end: Option<&str>,
        fill: char,
    ) -> ScheduleVersion {
        ScheduleVersion {
            digest: format!("v1:{}", fill.to_string().repeat(64)),
            date_retrieved: retrieved.into(),
            feed_start_date: start.map(Into::into),
            feed_end_date: end.map(Into::into),
        }
    }

    fn catalog(versions: Vec<ScheduleVersion>) -> ScheduleCatalog {
        ScheduleCatalog {
            base64url: "c2NoZWR1bGU".into(),
            schedule_url: "https://example.test/gtfs.zip".into(),
            versions,
        }
    }

    #[test]
    fn picks_the_latest_version_already_published_that_covers_the_day() {
        let catalogs = [catalog(vec![
            version(
                "2026-09-01T00:00:00Z",
                Some("20260101"),
                Some("20261231"),
                'a',
            ),
            version(
                "2026-10-01T00:00:00Z",
                Some("20260101"),
                Some("20261231"),
                'b',
            ),
            version(
                "2026-12-01T00:00:00Z",
                Some("20260101"),
                Some("20261231"),
                'c',
            ),
            version(
                "2026-10-15T00:00:00Z",
                Some("20261201"),
                Some("20261231"),
                'd',
            ),
        ])];
        let urls = ["https://example.test/gtfs.zip".to_owned()];
        let choice = choose_schedule(&urls, &catalogs, ServiceDate(20261105)).unwrap();
        assert_eq!(choice.retrieved, ["2026-10-01T00:00:00Z"]);
        assert!(choice.published_before);
    }

    #[test]
    fn falls_back_to_a_later_capture_and_says_so() {
        let catalogs = [catalog(vec![version(
            "2026-12-01T00:00:00Z",
            Some("20260101"),
            Some("20261231"),
            'a',
        )])];
        let urls = ["https://example.test/gtfs.zip".to_owned()];
        let choice = choose_schedule(&urls, &catalogs, ServiceDate(20261105)).unwrap();
        assert!(!choice.published_before);
    }

    #[test]
    fn missing_feed_dates_mean_open_ended_coverage() {
        let catalogs = [catalog(vec![version(
            "2026-01-01T00:00:00Z",
            None,
            None,
            'a',
        )])];
        let urls = ["https://example.test/gtfs.zip".to_owned()];
        assert!(choose_schedule(&urls, &catalogs, ServiceDate(20261105)).is_some());
    }

    #[test]
    fn no_choice_without_a_catalog_or_a_covering_version() {
        let urls = ["https://example.test/other.zip".to_owned()];
        assert!(choose_schedule(&urls, &[catalog(vec![])], ServiceDate(20261105)).is_none());
        assert!(choose_schedule(&[], &[], ServiceDate(20261105)).is_none());
        let expired = [catalog(vec![version(
            "2025-01-01T00:00:00Z",
            Some("20250101"),
            Some("20250601"),
            'a',
        )])];
        let urls = ["https://example.test/gtfs.zip".to_owned()];
        assert!(choose_schedule(&urls, &expired, ServiceDate(20261105)).is_none());
    }

    #[test]
    fn invalid_digests_are_never_put_in_a_url() {
        let mut bad = version("2026-01-01T00:00:00Z", None, None, 'a');
        bad.digest = "v1:../../etc".into();
        let urls = ["https://example.test/gtfs.zip".to_owned()];
        assert!(choose_schedule(&urls, &[catalog(vec![bad])], ServiceDate(20261105)).is_none());
    }
}
