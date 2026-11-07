//! Runs the generated SQL in a real DuckDB, on a fixture Parquet file, without a
//! browser or a live archive. Needs the `duckdb` CLI, or `DUCKDB_BIN`:
//!
//! ```sh
//! cargo test -p transit-core --test sql_contract -- --ignored
//! ```
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};
use transit_core::sql::{fixes_query, schedule_query};

fn duckdb(directory: &Path, script: &str) -> String {
    let binary = env::var("DUCKDB_BIN").unwrap_or_else(|_| "duckdb".to_owned());
    let output = Command::new(binary)
        .current_dir(directory)
        .args(["-no-agent", "-csv", "-noheader", "-c", script])
        .output()
        .expect("the duckdb CLI runs");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

fn fixture(name: &str) -> PathBuf {
    let directory = env::temp_dir().join(format!("transit-sql-{name}-{}", std::process::id()));
    fs::create_dir_all(&directory).unwrap();
    directory
}

/// Epoch seconds for the fixture's first poll, 2026-11-05 12:00:00 UTC.
const T0: i64 = 1_793_880_000;

/// `value` and `name` add one extra column, such as `, false` and `, is_deleted`.
fn write_positions(directory: &Path, value: &str, name: &str) {
    let script = format!(
        "COPY (SELECT * FROM (VALUES
            (to_timestamp({T0}), 'V1', 'T1', 'R1', 43.0::FLOAT, -89.0::FLOAT, {T0}::BIGINT{value}),
            (to_timestamp({T0} + 20), 'V1', 'T1', 'R1', 43.1::FLOAT, -89.0::FLOAT, 0::BIGINT{value}),
            (to_timestamp({T0} + 7200), 'V2', NULL, NULL, 43.2::FLOAT, -89.0::FLOAT, {T0}::BIGINT{value})
        ) AS t(fetch_timestamp, vehicle_id, trip_id, route_id, latitude, longitude, \"timestamp\"{name}))
        TO 'rt.parquet' (FORMAT parquet);"
    );
    duckdb(directory, &script);
}

fn columns(directory: &Path, file: &str) -> Vec<String> {
    duckdb(
        directory,
        &format!("SELECT column_name FROM (DESCRIBE SELECT * FROM read_parquet('{file}'));"),
    )
    .lines()
    .map(str::to_owned)
    .collect()
}

#[test]
#[ignore = "needs the duckdb CLI"]
fn the_window_filter_keeps_only_rows_inside_the_span() {
    let directory = fixture("window");
    write_positions(&directory, "", "");
    let sql = fixes_query(
        &columns(&directory, "rt.parquet"),
        "rt.parquet",
        T0,
        T0 + 3600,
    )
    .unwrap();
    let rows = duckdb(&directory, &format!("SELECT count(*) FROM ({sql});"));
    assert_eq!(rows, "2");
    fs::remove_dir_all(directory).unwrap();
}

#[test]
#[ignore = "needs the duckdb CLI"]
fn columns_missing_from_a_file_become_typed_nulls_with_safe_defaults() {
    let directory = fixture("missing");
    write_positions(&directory, "", "");
    let sql = fixes_query(
        &columns(&directory, "rt.parquet"),
        "rt.parquet",
        T0,
        T0 + 3600,
    )
    .unwrap();
    let row = duckdb(
        &directory,
        &format!(
            "SELECT occupancy_status, differential, start_date IS NULL, start_time IS NULL FROM ({sql}) LIMIT 1;"
        ),
    );
    assert_eq!(row, "-1,0,true,true");
    fs::remove_dir_all(directory).unwrap();
}

#[test]
#[ignore = "needs the duckdb CLI"]
fn deleted_entities_are_excluded_when_the_column_exists() {
    let directory = fixture("deleted");
    write_positions(&directory, ", true", ", is_deleted");
    let names = columns(&directory, "rt.parquet");
    assert!(names.iter().any(|name| name == "is_deleted"));
    let sql = fixes_query(&names, "rt.parquet", T0, T0 + 3600).unwrap();
    assert_eq!(
        duckdb(&directory, &format!("SELECT count(*) FROM ({sql});")),
        "0"
    );
    fs::remove_dir_all(directory).unwrap();
}

#[test]
#[ignore = "needs the duckdb CLI"]
fn stop_times_survive_blank_and_overnight_values_as_text() {
    let directory = fixture("stop-times");
    duckdb(
        &directory,
        "COPY (SELECT * FROM (VALUES
            ('T1', 'S1', '1', '25:10:00', '25:10:30', '1'),
            ('T1', 'S2', '2', '', '', ''),
            ('T1', 'S3', 'x', '25:20:00', '25:20:00', '0')
        ) AS t(trip_id, stop_id, stop_sequence, arrival_time, departure_time, timepoint))
        TO 'st.parquet' (FORMAT parquet);",
    );
    let names = columns(&directory, "st.parquet");
    let sql = schedule_query("stop_times", &names, "st.parquet").unwrap();
    let rows = duckdb(
        &directory,
        &format!("SELECT stop_sequence, arrival_time, timepoint FROM ({sql}) ORDER BY stop_id;"),
    );
    let lines: Vec<&str> = rows.lines().collect();
    assert_eq!(lines[0], "1,25:10:00,1");
    assert!(
        lines[1].ends_with(",-1"),
        "a blank timepoint is unknown: {}",
        lines[1]
    );
    assert!(
        lines[2].starts_with("0,"),
        "a bad sequence falls back: {}",
        lines[2]
    );
    fs::remove_dir_all(directory).unwrap();
}
