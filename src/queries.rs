//! SQL is generated from fixed templates, validated aliases, and escaped values.
use crate::model::{Mode, RouteMetadata, SourceFile};
use crate::planner::PlanError;
use std::collections::HashSet;

pub const METRIC_VERSION: &str = "archive-observations-v1";
pub const MAX_ROUTES: usize = 500;
pub const MAX_POSITIONS: usize = 5000;

pub fn literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

pub fn normalization(columns: &[String], files: &[SourceFile]) -> Result<String, PlanError> {
    let columns: HashSet<&str> = columns.iter().map(String::as_str).collect();
    if !columns.contains("fetch_timestamp") {
        return Err(PlanError(
            "This archive has no fetch_timestamp column. Choose a different feed or date.".into(),
        ));
    }
    let expression = |name: &str, ty: &str| {
        if columns.contains(name) {
            format!("TRY_CAST(\"{name}\" AS {ty})")
        } else {
            format!("CAST(NULL AS {ty})")
        }
    };
    let string = |name| format!("NULLIF({}, '') AS {name}", expression(name, "VARCHAR"));
    let aliases = files
        .iter()
        .filter(|f| f.status == "available")
        .map(|f| {
            if !f.alias.starts_with("day_")
                || !f.alias.ends_with(".parquet")
                || f.alias.contains(['\'', '/', '\\'])
            {
                return Err(PlanError("Unexpected archive alias.".into()));
            }
            Ok(literal(&f.alias))
        })
        .collect::<Result<Vec<_>, _>>()?;
    if aliases.is_empty() {
        return Err(PlanError(
            "No archive objects are available for these dates. Try another day.".into(),
        ));
    }
    let fields = [
        "route_id",
        "vehicle_id",
        "trip_id",
        "entity_id",
        "source_file",
    ]
    .map(string)
    .join(",\n  ");
    Ok(format!(
        "CREATE OR REPLACE TEMP TABLE observations AS\nSELECT\n  {fields},\n  TRY_CAST(fetch_timestamp AS TIMESTAMPTZ) AS fetch_timestamp,\n  {} AS event_seconds,\n  {} AS latitude,\n  {} AS longitude,\n  {} AS incrementality\nFROM read_parquet([{}], union_by_name = true, hive_partitioning = false);",
        expression("timestamp", "DOUBLE"),
        expression("latitude", "DOUBLE"),
        expression("longitude", "DOUBLE"),
        expression("incrementality", "INTEGER"),
        aliases.join(", ")
    ))
}

pub fn aggregates(
    mode: Mode,
    route: Option<&str>,
    routes: &[RouteMetadata],
) -> Vec<(String, String)> {
    let mut predicates = Vec::new();
    if mode != Mode::All {
        let ids: Vec<String> = routes
            .iter()
            .filter(|r| Mode::from_route_type(r.route_type) == mode)
            .map(|r| literal(&r.route_id))
            .collect();
        if mode == Mode::Unknown {
            let known = routes
                .iter()
                .filter(|r| r.route_type.is_some())
                .map(|r| literal(&r.route_id))
                .collect::<Vec<_>>();
            predicates.push(if known.is_empty() {
                "true".into()
            } else {
                format!(
                    "(route_id IS NULL OR route_id NOT IN ({}))",
                    known.join(", ")
                )
            });
        } else {
            predicates.push(if ids.is_empty() {
                "false".into()
            } else {
                format!("route_id IN ({})", ids.join(", "))
            });
        }
    }
    if let Some(route) = route {
        predicates.push(if route.is_empty() {
            "route_id IS NULL".into()
        } else {
            format!("route_id = {}", literal(route))
        });
    }
    let filter = if predicates.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", predicates.join(" AND "))
    };
    let data = format!("(SELECT * FROM observations{filter})");
    let valid_position = "latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180 AND NOT (latitude = 0 AND longitude = 0)";
    vec![
        (
            "summary".into(),
            format!(
                "SELECT count(*) AS observations,\n  count(DISTINCT vehicle_id) AS vehicles, count(DISTINCT route_id) AS routes,\n  count(DISTINCT trip_id) AS trip_ids,\n  count(*) FILTER (WHERE {valid_position}) AS valid_positions,\n  count(*) FILTER (WHERE vehicle_id IS NULL) AS missing_vehicle,\n  count(*) FILTER (WHERE route_id IS NULL) AS missing_route,\n  count(*) FILTER (WHERE event_seconds IS NULL OR event_seconds <= 0) AS missing_timestamp,\n  count(*) FILTER (WHERE incrementality = 1) AS differential,\n  count(*) FILTER (WHERE vehicle_id IS NOT NULL AND event_seconds > 0) -\n    count(DISTINCT (vehicle_id, route_id, trip_id, event_seconds, latitude, longitude)) FILTER (WHERE vehicle_id IS NOT NULL AND event_seconds > 0) AS repeated_fixes,\n  strftime(min(fetch_timestamp), '%Y-%m-%d %H:%M:%S UTC') AS first_fetch,\n  strftime(max(fetch_timestamp), '%Y-%m-%d %H:%M:%S UTC') AS last_fetch\nFROM {data};"
            ),
        ),
        (
            "routes".into(),
            format!(
                "SELECT coalesce(route_id, '') AS route_id, count(*) AS observations,\n  count(DISTINCT vehicle_id) AS vehicles, count(DISTINCT trip_id) AS trip_ids,\n  count(DISTINCT date_trunc('hour', fetch_timestamp)) AS hours,\n  count(*) FILTER (WHERE {valid_position}) AS valid_positions\nFROM {data} GROUP BY route_id ORDER BY observations DESC, route_id LIMIT {};",
                MAX_ROUTES + 1
            ),
        ),
        (
            "hours".into(),
            format!(
                "SELECT extract(hour FROM fetch_timestamp)::INTEGER AS hour, count(*) AS observations,\n  count(DISTINCT vehicle_id) AS vehicles\nFROM {data} WHERE fetch_timestamp IS NOT NULL GROUP BY hour ORDER BY hour;"
            ),
        ),
        (
            "route_hours".into(),
            format!(
                "SELECT coalesce(route_id, '') AS route_id, extract(hour FROM fetch_timestamp)::INTEGER AS hour, count(*) AS observations\nFROM {data} WHERE fetch_timestamp IS NOT NULL GROUP BY route_id, hour ORDER BY route_id, hour LIMIT 12001;"
            ),
        ),
        (
            "coverage".into(),
            format!(
                "SELECT strftime(date_trunc('hour', fetch_timestamp), '%Y-%m-%dT%H:00:00Z') AS hour,\n  count(*) AS observations, count(DISTINCT fetch_timestamp) AS fetches\nFROM {data} WHERE fetch_timestamp IS NOT NULL GROUP BY hour ORDER BY hour LIMIT 145;"
            ),
        ),
        (
            "positions".into(),
            format!(
                "WITH latest AS (\n  SELECT *, row_number() OVER (PARTITION BY vehicle_id ORDER BY fetch_timestamp DESC NULLS LAST, event_seconds DESC NULLS LAST, source_file DESC NULLS LAST, entity_id DESC NULLS LAST, route_id, latitude, longitude) AS position_rank\n  FROM {data} WHERE vehicle_id IS NOT NULL\n)\nSELECT vehicle_id, coalesce(route_id, '') AS route_id, latitude, longitude,\n  CASE WHEN event_seconds > 0 AND event_seconds < 253402300800 THEN strftime(to_timestamp(event_seconds), '%Y-%m-%d %H:%M:%S UTC') END AS observed_at,\n  coalesce(strftime(fetch_timestamp, '%Y-%m-%d %H:%M:%S UTC'), 'Unknown fetch time') AS fetch_at,\n  CASE WHEN event_seconds > 0 AND event_seconds < 253402300800 THEN 'vehicle timestamp' ELSE 'fetch timestamp fallback' END AS time_source\nFROM latest WHERE position_rank = 1 AND {valid_position}\n  AND NOT EXISTS (SELECT 1 FROM {data} WHERE incrementality = 1)\nORDER BY vehicle_id LIMIT {MAX_POSITIONS};"
            ),
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quotes_source_identifiers_as_values() {
        assert_eq!(
            literal("O'Hare'); DROP TABLE observations;--"),
            "'O''Hare''); DROP TABLE observations;--'"
        );
        let sql = aggregates(Mode::All, Some("a'b"), &[]);
        assert!(sql.iter().all(|(_, sql)| sql.contains("route_id = 'a''b'")));
    }
    #[test]
    fn supplies_typed_nulls_for_optional_historical_columns() {
        let file = SourceFile {
            date: "2026-11-05".into(),
            alias: "day_0.parquet".into(),
            url: String::new(),
            bytes: 1,
            status: "available".into(),
        };
        let sql = normalization(&["fetch_timestamp".into()], &[file]).unwrap();
        assert!(sql.contains("CAST(NULL AS DOUBLE) AS event_seconds"));
        assert!(sql.contains("union_by_name = true"));
        assert!(normalization(&[], &[]).is_err());
    }
    #[test]
    fn mode_filter_does_not_silently_include_unmatched_routes() {
        let route = RouteMetadata {
            route_id: "bus'1".into(),
            route_short_name: None,
            route_long_name: None,
            route_type: Some(3),
        };
        assert!(
            aggregates(Mode::Bus, None, std::slice::from_ref(&route))[0]
                .1
                .contains("route_id IN ('bus''1')")
        );
        assert!(
            aggregates(Mode::Rail, None, &[route])[0]
                .1
                .contains("WHERE false")
        );
        assert_eq!(Mode::from_route_type(Some(700)), Mode::Bus);
        assert_eq!(Mode::from_route_type(Some(2)), Mode::Rail);
    }
}
