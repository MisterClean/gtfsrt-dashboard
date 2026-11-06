//! The SQL DuckDB runs. Every query comes from these fixed templates, with
//! aliases checked and source values escaped, so catalog contents can't alter it.

use std::collections::HashSet;

/// Quotes a value as a SQL string literal.
pub fn literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn checked_alias(alias: &str) -> Result<String, String> {
    let valid = alias.ends_with(".parquet")
        && alias
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.');
    if valid {
        Ok(literal(alias))
    } else {
        Err("Unexpected archive alias.".to_owned())
    }
}

/// A column cast to `ty`, or a typed null when this file doesn't have it.
/// Older partitions lack columns that newer ones carry.
fn column(columns: &HashSet<&str>, name: &str, ty: &str) -> String {
    if columns.contains(name) {
        format!("TRY_CAST(\"{name}\" AS {ty})")
    } else {
        format!("CAST(NULL AS {ty})")
    }
}

/// Which columns an object has, since older files lack some that newer ones carry.
pub fn describe_query(alias: &str) -> Result<String, String> {
    Ok(format!(
        "DESCRIBE SELECT * FROM read_parquet({})",
        checked_alias(alias)?
    ))
}

/// A feed's schedule sources. The feed key is bound as a parameter.
pub const FEED_METADATA_QUERY: &str = "SELECT schedule_urls, schedule_url FROM read_parquet('feeds.parquet') WHERE base64url = ? AND feed_type = 'vehicle_positions'";

/// One longitude from a realtime object, to estimate the time zone of a feed with no
/// schedule to state one.
pub fn longitude_query(columns: &[String], alias: &str) -> Result<String, String> {
    if !columns.iter().any(|column| column == "longitude") {
        return Err("This archive object has no longitude column.".to_owned());
    }
    Ok(format!(
        "SELECT longitude FROM read_parquet({}) WHERE longitude IS NOT NULL AND longitude <> 0 LIMIT 1",
        checked_alias(alias)?
    ))
}

/// Reads one realtime object inside a time window. The filter on the fetch time
/// lets DuckDB skip row groups using their statistics, which is what keeps a
/// window read from fetching the whole object.
pub fn fixes_query(
    columns: &[String],
    alias: &str,
    window_start: i64,
    window_end: i64,
) -> Result<String, String> {
    let columns: HashSet<&str> = columns.iter().map(String::as_str).collect();
    if !columns.contains("fetch_timestamp") {
        return Err("This archive object has no fetch_timestamp column.".to_owned());
    }
    let alias = checked_alias(alias)?;
    let number = |name: &str, ty: &str, fallback: &str| {
        format!(
            "COALESCE({}, {fallback}) AS {name}",
            column(&columns, name, ty)
        )
    };
    let text = |name: &str| format!("{} AS {name}", column(&columns, name, "VARCHAR"));
    let deleted = if columns.contains("is_deleted") {
        "\n  AND COALESCE(TRY_CAST(is_deleted AS BOOLEAN), false) = false"
    } else {
        ""
    };
    Ok(format!(
        "SELECT\n  epoch(fetch_timestamp) AS fetch,\n  {timestamp},\n  {latitude},\n  {longitude},\n  {occupancy},\n  CAST(COALESCE({incrementality} = 1, false) AS TINYINT) AS differential,\n  {trip},\n  {vehicle},\n  {route},\n  {start_date},\n  {start_time}\nFROM read_parquet({alias})\nWHERE fetch_timestamp >= to_timestamp({window_start})\n  AND fetch_timestamp < to_timestamp({window_end}){deleted}",
        timestamp = number("timestamp", "DOUBLE", "0"),
        latitude = number("latitude", "FLOAT", "0"),
        longitude = number("longitude", "FLOAT", "0"),
        occupancy = number("occupancy_status", "TINYINT", "-1"),
        incrementality = column(&columns, "incrementality", "INTEGER"),
        trip = text("trip_id"),
        vehicle = text("vehicle_id"),
        route = text("route_id"),
        start_date = text("start_date"),
        start_time = text("start_time"),
    ))
}

fn table_query(
    columns: &[String],
    alias: &str,
    wanted: &[(&str, &str)],
    tail: &str,
) -> Result<String, String> {
    let alias = checked_alias(alias)?;
    let columns: HashSet<&str> = columns.iter().map(String::as_str).collect();
    let select = wanted
        .iter()
        .map(|(name, ty)| format!("{} AS {name}", column(&columns, name, ty)))
        .collect::<Vec<_>>()
        .join(", ");
    Ok(format!("SELECT {select} FROM read_parquet({alias}){tail}"))
}

/// The columns each schedule table needs. Everything in the archive's schedule
/// tables is stored as text, so casts here also validate.
pub fn schedule_query(table: &str, columns: &[String], alias: &str) -> Result<String, String> {
    match table {
        "agency" => table_query(columns, alias, &[("agency_timezone", "VARCHAR")], ""),
        "routes" => table_query(
            columns,
            alias,
            &[
                ("route_id", "VARCHAR"),
                ("route_short_name", "VARCHAR"),
                ("route_long_name", "VARCHAR"),
                ("route_type", "INTEGER"),
                ("route_color", "VARCHAR"),
                ("route_text_color", "VARCHAR"),
            ],
            "",
        ),
        "stops" => table_query(
            columns,
            alias,
            &[
                ("stop_id", "VARCHAR"),
                ("stop_code", "VARCHAR"),
                ("stop_name", "VARCHAR"),
                ("stop_lat", "DOUBLE"),
                ("stop_lon", "DOUBLE"),
            ],
            "",
        ),
        "shapes" => table_query(
            columns,
            alias,
            &[
                ("shape_id", "VARCHAR"),
                ("shape_pt_sequence", "INTEGER"),
                ("shape_pt_lat", "DOUBLE"),
                ("shape_pt_lon", "DOUBLE"),
            ],
            // These go straight to typed arrays, where a null would read as a number.
            " WHERE TRY_CAST(shape_pt_sequence AS INTEGER) IS NOT NULL AND TRY_CAST(shape_pt_lat AS DOUBLE) IS NOT NULL AND TRY_CAST(shape_pt_lon AS DOUBLE) IS NOT NULL",
        ),
        "trips" => table_query(
            columns,
            alias,
            &[
                ("trip_id", "VARCHAR"),
                ("route_id", "VARCHAR"),
                ("service_id", "VARCHAR"),
                ("direction_id", "UTINYINT"),
                ("shape_id", "VARCHAR"),
                ("trip_headsign", "VARCHAR"),
            ],
            "",
        ),
        "stop_times" => {
            let alias = checked_alias(alias)?;
            let names: HashSet<&str> = columns.iter().map(String::as_str).collect();
            let timepoint = if names.contains("timepoint") {
                "CAST(COALESCE(TRY_CAST(NULLIF(CAST(timepoint AS VARCHAR), '') AS TINYINT), -1) AS TINYINT)"
            } else {
                "CAST(-1 AS TINYINT)"
            };
            Ok(format!(
                "SELECT {trip} AS trip_id, {stop} AS stop_id, COALESCE({sequence}, 0) AS stop_sequence, {arrival} AS arrival_time, {departure} AS departure_time, {timepoint} AS timepoint FROM read_parquet({alias})",
                trip = column(&names, "trip_id", "VARCHAR"),
                stop = column(&names, "stop_id", "VARCHAR"),
                sequence = column(&names, "stop_sequence", "INTEGER"),
                arrival = column(&names, "arrival_time", "VARCHAR"),
                departure = column(&names, "departure_time", "VARCHAR"),
            ))
        }
        "calendar" => table_query(
            columns,
            alias,
            &[
                ("service_id", "VARCHAR"),
                ("monday", "INTEGER"),
                ("tuesday", "INTEGER"),
                ("wednesday", "INTEGER"),
                ("thursday", "INTEGER"),
                ("friday", "INTEGER"),
                ("saturday", "INTEGER"),
                ("sunday", "INTEGER"),
                ("start_date", "UINTEGER"),
                ("end_date", "UINTEGER"),
            ],
            "",
        ),
        "calendar_dates" => table_query(
            columns,
            alias,
            &[
                ("service_id", "VARCHAR"),
                ("date", "UINTEGER"),
                ("exception_type", "INTEGER"),
            ],
            "",
        ),
        other => Err(format!("Unknown schedule table {other}.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn columns(names: &[&str]) -> Vec<String> {
        names.iter().map(|n| (*n).to_owned()).collect()
    }

    #[test]
    fn literals_escape_quotes() {
        assert_eq!(literal("O'Hare'); DROP--"), "'O''Hare''); DROP--'");
    }

    #[test]
    fn fixes_query_supplies_typed_nulls_for_columns_a_file_lacks() {
        let sql = fixes_query(
            &columns(&["fetch_timestamp", "trip_id"]),
            "rt_0.parquet",
            10,
            20,
        )
        .unwrap();
        assert!(sql.contains("TRY_CAST(\"trip_id\" AS VARCHAR)"));
        assert!(sql.contains("CAST(NULL AS VARCHAR) AS vehicle_id"));
        assert!(sql.contains("COALESCE(CAST(NULL AS DOUBLE), 0) AS timestamp"));
        assert!(sql.contains("to_timestamp(10)"));
        assert!(sql.contains("to_timestamp(20)"));
        assert!(!sql.contains("is_deleted"));
    }

    #[test]
    fn fixes_query_excludes_deleted_entities_when_the_column_exists() {
        let sql = fixes_query(
            &columns(&["fetch_timestamp", "is_deleted"]),
            "rt_0.parquet",
            0,
            1,
        )
        .unwrap();
        assert!(sql.contains("is_deleted"));
    }

    #[test]
    fn a_file_without_fetch_times_is_an_error() {
        assert!(fixes_query(&columns(&["trip_id"]), "rt_0.parquet", 0, 1).is_err());
    }

    #[test]
    fn aliases_cannot_smuggle_sql() {
        let cols = columns(&["fetch_timestamp"]);
        assert!(fixes_query(&cols, "x.parquet'); DROP TABLE t;--", 0, 1).is_err());
        assert!(fixes_query(&cols, "../x.parquet", 0, 1).is_err());
        assert!(schedule_query("routes", &cols, "a'.parquet").is_err());
    }

    #[test]
    fn a_shape_row_with_blank_values_is_filtered_out() {
        let names = columns(&[
            "shape_id",
            "shape_pt_sequence",
            "shape_pt_lat",
            "shape_pt_lon",
        ]);
        let sql = schedule_query("shapes", &names, "s.parquet").unwrap();
        assert!(sql.contains("IS NOT NULL"), "{sql}");
    }

    #[test]
    fn the_time_zone_probe_needs_a_longitude_column() {
        assert!(longitude_query(&columns(&["trip_id"]), "a.parquet").is_err());
        assert!(longitude_query(&columns(&["longitude"]), "a.parquet").is_ok());
        assert!(describe_query("a'.parquet").is_err());
    }

    #[test]
    fn unknown_tables_are_refused() {
        assert!(schedule_query("pg_catalog", &[], "a.parquet").is_err());
    }

    #[test]
    fn stop_times_handle_a_missing_timepoint_column() {
        let names = columns(&[
            "trip_id",
            "stop_id",
            "stop_sequence",
            "arrival_time",
            "departure_time",
        ]);
        let sql = schedule_query("stop_times", &names, "st.parquet").unwrap();
        assert!(sql.contains("CAST(-1 AS TINYINT) AS timepoint"));
    }
}
