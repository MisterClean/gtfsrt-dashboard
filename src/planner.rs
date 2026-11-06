use crate::model::{Feed, FeedMetadata, PlannedFile, ScheduleCatalog, ScheduleChoice, Selection};
use chrono::{Days, NaiveDate};
use std::fmt;

pub const ARCHIVE: &str = "https://storage.googleapis.com/parquet.gtfsrt.io";
pub const MAX_FILES: usize = 6;
pub const MAX_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub struct PlanError(pub String);

impl fmt::Display for PlanError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for PlanError {}

fn date(value: &str) -> Result<NaiveDate, PlanError> {
    let parsed = NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map_err(|_| PlanError("Choose a valid date in YYYY-MM-DD format.".into()))?;
    if value != parsed.format("%Y-%m-%d").to_string() {
        return Err(PlanError("Dates must use YYYY-MM-DD format.".into()));
    }
    Ok(parsed)
}

pub fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 2048
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

pub fn plan_selection(feed: &Feed, from: &str, to: &str) -> Result<Selection, PlanError> {
    if feed.feed_type != "vehicle_positions" || !valid_key(&feed.base64url) {
        return Err(PlanError(
            "This feed is not a supported vehicle-position archive.".into(),
        ));
    }
    let first = date(from)?;
    let last = date(to)?;
    let days = last.signed_duration_since(first).num_days();
    if days < 0 {
        return Err(PlanError("The end date must follow the start date.".into()));
    }
    if days >= MAX_FILES as i64 {
        return Err(PlanError(
            "Select at most six UTC days. Larger raw scans do not fit the MVP budget.".into(),
        ));
    }
    if first < date(&feed.date_min)? || last > date(&feed.date_max)? {
        return Err(PlanError(format!(
            "The catalog lists this feed between {} and {}. Individual days may still be missing.",
            feed.date_min, feed.date_max
        )));
    }
    let files = (0..=days)
        .map(|i| {
            let day = first.checked_add_days(Days::new(i as u64)).ok_or_else(|| {
                PlanError("The date range is outside the supported calendar.".into())
            })?;
            let date = day.format("%Y-%m-%d").to_string();
            Ok(PlannedFile {
                url: format!(
                    "{ARCHIVE}/vehicle_positions/date={date}/base64url={}/data.parquet",
                    feed.base64url
                ),
                date,
                alias: format!("day_{i}.parquet"),
            })
        })
        .collect::<Result<Vec<_>, PlanError>>()?;
    Ok(Selection {
        feed: feed.clone(),
        from: from.into(),
        to: to.into(),
        files,
    })
}

pub fn enforce_byte_budget(bytes: impl IntoIterator<Item = u64>) -> Result<u64, PlanError> {
    let total = bytes
        .into_iter()
        .try_fold(0_u64, |sum, next| sum.checked_add(next))
        .ok_or_else(|| PlanError("Archive sizes are too large to inspect safely.".into()))?;
    if total > MAX_BYTES {
        return Err(PlanError(format!(
            "Selected objects total {:.1} MiB; the browser limit is 128 MiB. Select fewer days or a smaller feed.",
            total as f64 / 1_048_576.0
        )));
    }
    Ok(total)
}

/// Select metadata only when one unambiguous schedule covers the entire interval
/// and was retrieved before it. This does not validate historical trip joins.
pub fn choose_schedule(
    metadata: &[FeedMetadata],
    catalogs: &[ScheduleCatalog],
    selection: &Selection,
) -> Option<ScheduleChoice> {
    let [metadata] = metadata else {
        return None;
    };
    let urls: Vec<String> = metadata
        .schedule_urls
        .as_deref()
        .and_then(|json| serde_json::from_str(json).ok())
        .unwrap_or_else(|| metadata.schedule_url.iter().cloned().collect());
    let [url] = urls.as_slice() else {
        return None;
    };
    let catalog = catalogs
        .iter()
        .find(|s| &s.schedule_url == url && valid_key(&s.base64url))?;
    let from = selection.from.replace('-', "");
    let to = selection.to.replace('-', "");
    let version = catalog
        .versions
        .iter()
        .filter(|v| {
            v.feed_start_date
                .as_ref()
                .is_some_and(|start| start <= &from)
                && v.feed_end_date.as_ref().is_some_and(|end| end >= &to)
                && v.date_retrieved
                    .get(..10)
                    .is_some_and(|retrieved| retrieved < selection.from.as_str())
                && v.digest
                    .strip_prefix("v1:")
                    .is_some_and(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
        })
        .max_by_key(|v| &v.date_retrieved)?;
    Some(ScheduleChoice {
        url: format!(
            "{ARCHIVE}/schedules/base64url={}/_feed_digest={}/routes.parquet",
            catalog.base64url, version.digest
        ),
        digest: version.digest.clone(),
        retrieved: version.date_retrieved.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn feed() -> Feed {
        Feed {
            base64url: "cHVibGlj".into(),
            agency_id: Some("test".into()),
            agency_name: None,
            system_name: None,
            feed_type: "vehicle_positions".into(),
            date_min: "2026-01-01".into(),
            date_max: "2026-12-31".into(),
        }
    }

    #[test]
    fn plans_utc_dates_across_month_and_dst_boundaries() {
        let plan = plan_selection(&feed(), "2026-10-30", "2026-11-04").unwrap();
        assert_eq!(plan.files.len(), 6);
        assert_eq!(plan.files[2].date, "2026-11-01");
        assert!(
            plan.files
                .iter()
                .all(|f| f.url.starts_with(&format!("{ARCHIVE}/vehicle_positions/")))
        );
    }
    #[test]
    fn rejects_invalid_unbounded_and_injected_selections() {
        for (from, to) in [
            ("2026-02-30", "2026-03-01"),
            ("2026-11-01", "2026-10-31"),
            ("2026-11-01", "2026-11-07"),
            ("2025-12-31", "2026-01-01"),
            ("2026-1-01", "2026-01-01"),
        ] {
            assert!(plan_selection(&feed(), from, to).is_err(), "{from}..{to}");
        }
        let mut malicious = feed();
        malicious.base64url = "../other?sql='".into();
        assert!(plan_selection(&malicious, "2026-11-01", "2026-11-01").is_err());
    }
    #[test]
    fn enforces_the_entire_compressed_working_set() {
        assert_eq!(enforce_byte_budget([MAX_BYTES]).unwrap(), MAX_BYTES);
        assert!(enforce_byte_budget([MAX_BYTES, 1]).is_err());
        assert!(enforce_byte_budget([u64::MAX, 1]).is_err());
    }
}
