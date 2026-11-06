use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Feed {
    pub base64url: String,
    pub agency_id: Option<String>,
    pub agency_name: Option<String>,
    pub system_name: Option<String>,
    pub feed_type: String,
    pub date_min: String,
    pub date_max: String,
}

impl Feed {
    pub fn name(&self) -> &str {
        self.agency_name
            .as_deref()
            .or(self.agency_id.as_deref())
            .unwrap_or("Unnamed agency")
    }

    pub fn label(&self) -> String {
        self.system_name.as_ref().map_or_else(
            || self.name().to_owned(),
            |system| format!("{} · {system}", self.name()),
        )
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PlannedFile {
    pub date: String,
    pub alias: String,
    pub url: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Selection {
    pub feed: Feed,
    pub from: String,
    pub to: String,
    pub files: Vec<PlannedFile>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SourceFile {
    pub date: String,
    pub alias: String,
    pub url: String,
    pub bytes: u64,
    pub status: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct FeedMetadata {
    pub schedule_urls: Option<String>,
    pub schedule_url: Option<String>,
    pub interval_seconds: Option<f64>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ScheduleCatalog {
    pub base64url: String,
    pub schedule_url: String,
    pub versions: Vec<ScheduleVersion>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ScheduleVersion {
    #[serde(rename = "_feed_digest")]
    pub digest: String,
    pub date_retrieved: String,
    pub feed_start_date: Option<String>,
    pub feed_end_date: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ScheduleChoice {
    pub url: String,
    pub digest: String,
    pub retrieved: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct PreparedArchive {
    pub files: Vec<SourceFile>,
    pub columns: Vec<String>,
    pub engine_version: String,
    pub checked_at: String,
    pub metadata: Vec<FeedMetadata>,
    pub schedules: Vec<ScheduleCatalog>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum Mode {
    #[default]
    All,
    Bus,
    Rail,
    Ferry,
    Other,
    Unknown,
}

impl Mode {
    pub fn label(self) -> &'static str {
        match self {
            Self::All => "All modes",
            Self::Bus => "Bus",
            Self::Rail => "Rail",
            Self::Ferry => "Ferry",
            Self::Other => "Other modes",
            Self::Unknown => "Unmatched routes",
        }
    }

    pub fn from_route_type(route_type: Option<i32>) -> Self {
        match route_type {
            Some(3 | 11 | 200..=299 | 700..=799 | 800) => Self::Bus,
            Some(0..=2 | 5 | 7 | 12 | 100..=199 | 300..=499 | 900..=999 | 1400) => Self::Rail,
            Some(4 | 1000..=1099 | 1200) => Self::Ferry,
            Some(_) => Self::Other,
            None => Self::Unknown,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RouteMetadata {
    pub route_id: String,
    pub route_short_name: Option<String>,
    pub route_long_name: Option<String>,
    pub route_type: Option<i32>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Summary {
    pub observations: u64,
    pub vehicles: u64,
    pub routes: u64,
    pub trip_ids: u64,
    pub valid_positions: u64,
    pub missing_vehicle: u64,
    pub missing_route: u64,
    pub missing_timestamp: u64,
    pub differential: u64,
    pub repeated_fixes: u64,
    pub first_fetch: Option<String>,
    pub last_fetch: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RouteRow {
    pub route_id: String,
    pub observations: u64,
    pub vehicles: u64,
    pub trip_ids: u64,
    pub hours: u64,
    pub valid_positions: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct HourRow {
    pub hour: u32,
    pub observations: u64,
    pub vehicles: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RouteHour {
    pub route_id: String,
    pub hour: u32,
    pub observations: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CoverageRow {
    pub hour: String,
    pub observations: u64,
    pub fetches: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Position {
    pub vehicle_id: String,
    pub route_id: String,
    pub latitude: f64,
    pub longitude: f64,
    pub observed_at: Option<String>,
    pub fetch_at: String,
    pub time_source: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Analysis {
    pub summary: Vec<Summary>,
    pub routes: Vec<RouteRow>,
    pub hours: Vec<HourRow>,
    pub route_hours: Vec<RouteHour>,
    pub coverage: Vec<CoverageRow>,
    pub positions: Vec<Position>,
    pub elapsed_ms: f64,
}

#[derive(Clone, Debug)]
pub struct Report {
    pub selection: Selection,
    pub prepared: PreparedArchive,
    pub schedule: Option<ScheduleChoice>,
    pub route_metadata: Vec<RouteMetadata>,
    pub analysis: Analysis,
    pub available_routes: Vec<RouteRow>,
    pub mode: Mode,
    pub route: Option<String>,
    pub sql: Vec<(String, String)>,
    pub warnings: Vec<String>,
}

impl Report {
    pub fn summary(&self) -> Summary {
        self.analysis.summary.first().cloned().unwrap_or_default()
    }

    pub fn route_name(&self, id: &str) -> String {
        self.route_metadata
            .iter()
            .find(|r| r.route_id == id)
            .and_then(|r| r.route_long_name.as_deref())
            .filter(|s| !s.is_empty())
            .unwrap_or(if id.is_empty() {
                "Unreported route"
            } else {
                ""
            })
            .to_owned()
    }

    pub fn route_mode(&self, id: &str) -> Mode {
        Mode::from_route_type(
            self.route_metadata
                .iter()
                .find(|r| r.route_id == id)
                .and_then(|r| r.route_type),
        )
    }
}
