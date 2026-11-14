-- Schedule staging: the archive's all-text GTFS tables, typed.
-- One row per schedule version (feed_digest) and natural key. Optional tables
-- and columns that a version lacks come through as NULLs, never as errors. The version comes from the object path.

SET VARIABLE f_agency         = object_files('schedule:agency');
SET VARIABLE f_routes         = object_files('schedule:routes');
SET VARIABLE f_trips          = object_files('schedule:trips');
SET VARIABLE f_stop_times     = object_files('schedule:stop_times');
SET VARIABLE f_stops          = object_files('schedule:stops');
SET VARIABLE f_calendar       = object_files('schedule:calendar');
SET VARIABLE f_calendar_dates = object_files('schedule:calendar_dates');
SET VARIABLE f_shapes         = object_files('schedule:shapes');
SET VARIABLE f_frequencies    = object_files('schedule:frequencies');

CREATE OR REPLACE TABLE stg_agency AS
SELECT regexp_extract(filename, '_feed_digest=([^/]+)/', 1) AS feed_digest, blank_null(agency_id) AS agency_id, agency_name, agency_timezone
FROM (
  SELECT NULL::VARCHAR AS filename, NULL::VARCHAR AS agency_id, NULL::VARCHAR AS agency_name,
         NULL::VARCHAR AS agency_timezone WHERE false
  UNION ALL BY NAME
  SELECT * FROM read_parquet(getvariable('f_agency'), union_by_name = true, filename = true, hive_partitioning = false)
);

CREATE OR REPLACE TABLE stg_routes AS
SELECT
  regexp_extract(filename, '_feed_digest=([^/]+)/', 1) AS feed_digest,
  route_id,
  blank_null(agency_id)         AS agency_id,
  blank_null(route_short_name)  AS route_short_name,
  blank_null(route_long_name)   AS route_long_name,
  TRY_CAST(route_type AS INTEGER) AS route_type
FROM (
  SELECT NULL::VARCHAR AS filename, NULL::VARCHAR AS route_id, NULL::VARCHAR AS agency_id,
         NULL::VARCHAR AS route_short_name, NULL::VARCHAR AS route_long_name,
         NULL::VARCHAR AS route_type WHERE false
  UNION ALL BY NAME
  SELECT * FROM read_parquet(getvariable('f_routes'), union_by_name = true, filename = true, hive_partitioning = false)
);

CREATE OR REPLACE TABLE stg_trips AS
SELECT
  regexp_extract(filename, '_feed_digest=([^/]+)/', 1) AS feed_digest,
  trip_id,
  route_id,
  service_id,
  TRY_CAST(direction_id AS INTEGER) AS direction_id,
  blank_null(shape_id)      AS shape_id,
  blank_null(block_id)      AS block_id,
  blank_null(trip_headsign) AS trip_headsign
FROM (
  SELECT NULL::VARCHAR AS filename, NULL::VARCHAR AS trip_id, NULL::VARCHAR AS route_id,
         NULL::VARCHAR AS service_id, NULL::VARCHAR AS direction_id, NULL::VARCHAR AS shape_id,
         NULL::VARCHAR AS block_id, NULL::VARCHAR AS trip_headsign WHERE false
  UNION ALL BY NAME
  SELECT * FROM read_parquet(getvariable('f_trips'), union_by_name = true, filename = true, hive_partitioning = false)
);

CREATE OR REPLACE TABLE stg_stops AS
SELECT
  regexp_extract(filename, '_feed_digest=([^/]+)/', 1) AS feed_digest,
  stop_id,
  blank_null(stop_code) AS stop_code,
  blank_null(stop_name) AS stop_name,
  TRY_CAST(stop_lat AS DOUBLE) AS stop_lat,
  TRY_CAST(stop_lon AS DOUBLE) AS stop_lon,
  coalesce(TRY_CAST(location_type AS INTEGER), 0) AS location_type,
  blank_null(parent_station) AS parent_station
FROM (
  SELECT NULL::VARCHAR AS filename, NULL::VARCHAR AS stop_id, NULL::VARCHAR AS stop_code,
         NULL::VARCHAR AS stop_name, NULL::VARCHAR AS stop_lat, NULL::VARCHAR AS stop_lon,
         NULL::VARCHAR AS location_type, NULL::VARCHAR AS parent_station WHERE false
  UNION ALL BY NAME
  SELECT * FROM read_parquet(getvariable('f_stops'), union_by_name = true, filename = true, hive_partitioning = false)
);

CREATE OR REPLACE TABLE stg_stop_times AS
SELECT
  regexp_extract(filename, '_feed_digest=([^/]+)/', 1) AS feed_digest,
  trip_id,
  CAST(stop_sequence AS INTEGER)  AS stop_sequence,
  stop_id,
  gtfs_secs(arrival_time)         AS arrival_secs,
  gtfs_secs(departure_time)       AS departure_secs,
  TRY_CAST(timepoint AS INTEGER)  AS timepoint,
  TRY_CAST(shape_dist_traveled AS DOUBLE) AS shape_dist_traveled,
  coalesce(TRY_CAST(pickup_type AS INTEGER), 0)   AS pickup_type,
  coalesce(TRY_CAST(drop_off_type AS INTEGER), 0) AS drop_off_type
FROM (
  SELECT NULL::VARCHAR AS filename, NULL::VARCHAR AS trip_id, NULL::VARCHAR AS stop_sequence,
         NULL::VARCHAR AS stop_id, NULL::VARCHAR AS arrival_time, NULL::VARCHAR AS departure_time,
         NULL::VARCHAR AS timepoint, NULL::VARCHAR AS shape_dist_traveled,
         NULL::VARCHAR AS pickup_type, NULL::VARCHAR AS drop_off_type WHERE false
  UNION ALL BY NAME
  SELECT * FROM read_parquet(getvariable('f_stop_times'), union_by_name = true, filename = true, hive_partitioning = false)
);

CREATE OR REPLACE TABLE stg_calendar AS
SELECT
  regexp_extract(filename, '_feed_digest=([^/]+)/', 1) AS feed_digest,
  service_id,
  [sunday = '1', monday = '1', tuesday = '1', wednesday = '1', thursday = '1', friday = '1', saturday = '1'] AS runs_on_dow,
  gtfs_date(start_date) AS start_date,
  gtfs_date(end_date)   AS end_date
FROM (
  SELECT NULL::VARCHAR AS filename, NULL::VARCHAR AS service_id, NULL::VARCHAR AS monday,
         NULL::VARCHAR AS tuesday, NULL::VARCHAR AS wednesday, NULL::VARCHAR AS thursday,
         NULL::VARCHAR AS friday, NULL::VARCHAR AS saturday, NULL::VARCHAR AS sunday,
         NULL::VARCHAR AS start_date, NULL::VARCHAR AS end_date WHERE false
  UNION ALL BY NAME
  SELECT * FROM read_parquet(getvariable('f_calendar'), union_by_name = true, filename = true, hive_partitioning = false)
);

CREATE OR REPLACE TABLE stg_calendar_dates AS
SELECT
  regexp_extract(filename, '_feed_digest=([^/]+)/', 1) AS feed_digest,
  service_id,
  gtfs_date("date") AS service_date,
  TRY_CAST(exception_type AS INTEGER) AS exception_type
FROM (
  SELECT NULL::VARCHAR AS filename, NULL::VARCHAR AS service_id, NULL::VARCHAR AS "date",
         NULL::VARCHAR AS exception_type WHERE false
  UNION ALL BY NAME
  SELECT * FROM read_parquet(getvariable('f_calendar_dates'), union_by_name = true, filename = true, hive_partitioning = false)
);

CREATE OR REPLACE TABLE stg_shapes AS
SELECT
  regexp_extract(filename, '_feed_digest=([^/]+)/', 1) AS feed_digest,
  shape_id,
  CAST(shape_pt_sequence AS INTEGER) AS shape_pt_sequence,
  CAST(shape_pt_lat AS DOUBLE) AS shape_pt_lat,
  CAST(shape_pt_lon AS DOUBLE) AS shape_pt_lon
FROM (
  SELECT NULL::VARCHAR AS filename, NULL::VARCHAR AS shape_id, NULL::VARCHAR AS shape_pt_sequence,
         NULL::VARCHAR AS shape_pt_lat, NULL::VARCHAR AS shape_pt_lon WHERE false
  UNION ALL BY NAME
  SELECT * FROM read_parquet(getvariable('f_shapes'), union_by_name = true, filename = true, hive_partitioning = false)
);

CREATE OR REPLACE TABLE stg_frequencies AS
SELECT regexp_extract(filename, '_feed_digest=([^/]+)/', 1) AS feed_digest, trip_id
FROM (
  SELECT NULL::VARCHAR AS filename, NULL::VARCHAR AS trip_id WHERE false
  UNION ALL BY NAME
  SELECT * FROM read_parquet(getvariable('f_frequencies'), union_by_name = true, filename = true, hive_partitioning = false)
)
GROUP BY ALL;
