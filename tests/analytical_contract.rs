//! Independent native-engine checks for the SQL that the browser executes.
//! Run with: cargo test --test analytical_contract -- --ignored
use gtfsrt_dashboard::model::{Mode, RouteMetadata};
use gtfsrt_dashboard::queries;
use serde_json::Value;
use std::process::Command;

const FIXTURE: &str = "
CREATE TEMP TABLE observations (
 route_id VARCHAR, vehicle_id VARCHAR, trip_id VARCHAR, entity_id VARCHAR,
 source_file VARCHAR, fetch_timestamp TIMESTAMPTZ, event_seconds DOUBLE,
 latitude DOUBLE, longitude DOUBLE, incrementality INTEGER
);
INSERT INTO observations VALUES
 ('A','v1','t1','e1','s1','2026-11-05 00:00:01+00',100,43,-89,0),
 ('A','v1','t1','e1','s2','2026-11-05 00:00:21+00',100,43,-89,0),
 ('A','v1','t1','e1','s3','2026-11-05 01:00:00+00',200,NULL,NULL,0),
 ('A','v2','t2','e2','s1','2026-11-05 01:00:00+00',NULL,43.1,-89,0),
 ('B','v3','t3','e3','s1','2026-11-05 01:00:00+00',300,44,-90,0),
 (NULL,NULL,NULL,NULL,'s1','2026-11-05 01:00:00+00',300,0,0,0);
";

fn execute(setup: &str, query: &str) -> Vec<Value> {
    let binary = std::env::var_os("DUCKDB_BIN").unwrap_or_else(|| "duckdb".into());
    let output = Command::new(binary)
        .args(["-no-agent", "-json", "-c", &format!("{setup}\n{query}")])
        .output()
        .expect("Install the DuckDB CLI or set DUCKDB_BIN for the independent SQL checks");
    assert!(
        output.status.success(),
        "Native SQL failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).expect("DuckDB should return a JSON row array")
}

#[test]
#[ignore = "requires an independently installed DuckDB CLI"]
fn preserves_snapshot_grain_missingness_and_latest_position_semantics() {
    let queries = queries::aggregates(Mode::All, None, &[]);
    let query = |name: &str| &queries.iter().find(|(key, _)| key == name).unwrap().1;
    let rows = execute(FIXTURE, query("summary"));
    let summary = &rows[0];
    for (field, expected) in [
        ("observations", 6),
        ("vehicles", 3),
        ("routes", 2),
        ("trip_ids", 3),
        ("valid_positions", 4),
        ("missing_vehicle", 1),
        ("missing_route", 1),
        ("missing_timestamp", 1),
        ("repeated_fixes", 1),
    ] {
        assert_eq!(summary[field], expected, "{field}");
    }
    let positions = execute(FIXTURE, query("positions"));
    assert_eq!(
        positions.len(),
        2,
        "an older valid fix must not replace the invalid latest report"
    );
    assert_eq!(positions[0]["vehicle_id"], "v2");
    assert_eq!(positions[0]["time_source"], "fetch timestamp fallback");
    assert_eq!(execute(FIXTURE, query("coverage")).len(), 2);
    let differential =
        format!("{FIXTURE}\nUPDATE observations SET incrementality = 1 WHERE vehicle_id = 'v3';");
    assert!(execute(&differential, query("positions")).is_empty());
}

#[test]
#[ignore = "requires an independently installed DuckDB CLI"]
fn mode_and_route_filters_keep_unmatched_ids_distinct_and_treat_values_as_data() {
    let routes = [
        RouteMetadata {
            route_id: "A".into(),
            route_short_name: None,
            route_long_name: None,
            route_type: Some(3),
        },
        RouteMetadata {
            route_id: "B".into(),
            route_short_name: None,
            route_long_name: None,
            route_type: Some(2),
        },
    ];
    for (mode, expected) in [(Mode::Bus, 4), (Mode::Rail, 1), (Mode::Unknown, 1)] {
        let queries = queries::aggregates(mode, None, &routes);
        assert_eq!(
            execute(FIXTURE, &queries[0].1)[0]["observations"],
            expected,
            "{mode:?}"
        );
    }
    let queries = queries::aggregates(Mode::All, Some("A' OR true --"), &routes);
    assert_eq!(execute(FIXTURE, &queries[0].1)[0]["observations"], 0);
}
