-- Realtime staging. The archive stores one row per entity (and per stop time
-- update, or per informed entity) for every capture. Staging types the rows,
-- limits them to the read window of the service days being built, and reduces
-- repeated captures to the facts they state.

-- Read window per feed: the union of its system's service-day windows.
CREATE OR REPLACE TABLE int_feed_window AS
SELECT f.feed_key, f.feed_url, f.feed_type, f.system_key, f.poll_interval_s,
       min(d.read_start_ts) AS read_start_ts, max(d.read_end_ts) AS read_end_ts
FROM dim_feed f
JOIN dim_service_day d USING (system_key)
GROUP BY ALL;

-- ---------------------------------------------------------------------------
-- Raw views: typed columns, window filter, nothing dropped.
-- Optional columns vary by file, so each view unions onto a typed template.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW raw_vehicle_position AS
SELECT w.system_key, w.feed_key, r.*
FROM (
  SELECT NULL::VARCHAR AS feed_url, NULL::UBIGINT AS feed_timestamp, NULL::TIMESTAMPTZ AS fetch_timestamp,
         NULL::VARCHAR AS entity_id, NULL::VARCHAR AS trip_id, NULL::VARCHAR AS route_id,
         NULL::UINTEGER AS direction_id, NULL::VARCHAR AS start_time, NULL::VARCHAR AS start_date,
         NULL::INTEGER AS schedule_relationship, NULL::VARCHAR AS vehicle_id, NULL::VARCHAR AS vehicle_label,
         NULL::FLOAT AS latitude, NULL::FLOAT AS longitude, NULL::FLOAT AS bearing, NULL::FLOAT AS speed,
         NULL::UINTEGER AS current_stop_sequence, NULL::VARCHAR AS stop_id, NULL::INTEGER AS current_status,
         NULL::UBIGINT AS "timestamp", NULL::INTEGER AS occupancy_status, NULL::INTEGER AS incrementality,
         NULL::BOOLEAN AS is_deleted
  WHERE false
  UNION ALL BY NAME
  SELECT * FROM read_parquet(getvariable('f_vehicle_positions'), union_by_name = true, hive_partitioning = false)
) r
JOIN int_feed_window w
  ON w.feed_url = r.feed_url AND w.feed_type = 'vehicle_positions'
 AND r.fetch_timestamp >= w.read_start_ts AND r.fetch_timestamp < w.read_end_ts;

CREATE OR REPLACE VIEW raw_trip_update AS
SELECT w.system_key, w.feed_key, r.*
FROM (
  SELECT NULL::VARCHAR AS feed_url, NULL::UBIGINT AS feed_timestamp, NULL::TIMESTAMPTZ AS fetch_timestamp,
         NULL::VARCHAR AS entity_id, NULL::VARCHAR AS trip_id, NULL::VARCHAR AS route_id,
         NULL::UINTEGER AS direction_id, NULL::VARCHAR AS start_time, NULL::VARCHAR AS start_date,
         NULL::INTEGER AS schedule_relationship, NULL::VARCHAR AS vehicle_id, NULL::UBIGINT AS trip_timestamp,
         NULL::INTEGER AS trip_delay, NULL::UINTEGER AS stop_sequence, NULL::VARCHAR AS stop_id,
         NULL::INTEGER AS arrival_delay, NULL::BIGINT AS arrival_time, NULL::INTEGER AS arrival_uncertainty,
         NULL::INTEGER AS departure_delay, NULL::BIGINT AS departure_time,
         NULL::INTEGER AS stop_schedule_relationship, NULL::INTEGER AS incrementality,
         NULL::BOOLEAN AS is_deleted, NULL::VARCHAR AS trip_properties_trip_id,
         NULL::VARCHAR AS trip_properties_start_date, NULL::VARCHAR AS trip_properties_start_time
  WHERE false
  UNION ALL BY NAME
  SELECT * FROM read_parquet(getvariable('f_trip_updates'), union_by_name = true, hive_partitioning = false)
) r
JOIN int_feed_window w
  ON w.feed_url = r.feed_url AND w.feed_type = 'trip_updates'
 AND r.fetch_timestamp >= w.read_start_ts AND r.fetch_timestamp < w.read_end_ts;

CREATE OR REPLACE VIEW raw_service_alert AS
SELECT w.system_key, w.feed_key, r.*
FROM (
  SELECT NULL::VARCHAR AS feed_url, NULL::UBIGINT AS feed_timestamp, NULL::TIMESTAMPTZ AS fetch_timestamp,
         NULL::VARCHAR AS entity_id, NULL::INTEGER AS cause, NULL::INTEGER AS effect,
         NULL::INTEGER AS severity_level, NULL::UBIGINT AS active_period_start,
         NULL::UBIGINT AS active_period_end, NULL::VARCHAR AS header_text, NULL::VARCHAR AS description_text,
         NULL::VARCHAR AS agency_id, NULL::VARCHAR AS route_id, NULL::INTEGER AS route_type,
         NULL::VARCHAR AS stop_id, NULL::VARCHAR AS trip_id, NULL::VARCHAR AS trip_route_id,
         NULL::UINTEGER AS direction_id, NULL::VARCHAR AS trip_start_date,
         NULL::INTEGER AS trip_schedule_relationship, NULL::BOOLEAN AS is_deleted
  WHERE false
  UNION ALL BY NAME
  SELECT * FROM read_parquet(getvariable('f_service_alerts'), union_by_name = true, hive_partitioning = false)
) r
JOIN int_feed_window w
  ON w.feed_url = r.feed_url AND w.feed_type = 'service_alerts'
 AND r.fetch_timestamp >= w.read_start_ts AND r.fetch_timestamp < w.read_end_ts;

-- ---------------------------------------------------------------------------
-- stg_poll: one row per feed and capture that returned at least one row.
-- The archive writes no row for a capture that failed or returned an empty
-- feed, so the two cannot be told apart here.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE TABLE stg_poll AS
SELECT system_key, feed_key, 'vehicle_positions' AS feed_type, fetch_timestamp AS fetch_ts,
       to_timestamp(nullif(max(feed_timestamp), 0)) AS feed_ts,
       count(*) AS n_rows, count(DISTINCT entity_id) AS n_entities
FROM raw_vehicle_position GROUP BY ALL
UNION ALL
SELECT system_key, feed_key, 'trip_updates', fetch_timestamp,
       to_timestamp(nullif(max(feed_timestamp), 0)), count(*), count(DISTINCT entity_id)
FROM raw_trip_update GROUP BY ALL
UNION ALL
SELECT system_key, feed_key, 'service_alerts', fetch_timestamp,
       to_timestamp(nullif(max(feed_timestamp), 0)), count(*), count(DISTINCT entity_id)
FROM raw_service_alert GROUP BY ALL;

-- ---------------------------------------------------------------------------
-- stg_vehicle_position: one row per distinct report.
-- A report is a vehicle, trip descriptor and report time. Repeated captures of
-- an unchanged report, and a frozen GPS unit repeating one report time, keep
-- only the first capture. A report with no timestamp uses its capture time
-- and says so. Rows with no vehicle id or unusable coordinates are dropped
-- and counted in qa_vehicle_position_funnel.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE TABLE stg_vehicle_position AS
WITH typed AS (
  SELECT
    system_key,
    feed_key,
    fetch_timestamp AS fetch_ts,
    coalesce(to_timestamp(nullif("timestamp", 0)), fetch_timestamp) AS position_ts,
    nullif("timestamp", 0) IS NOT NULL AS has_position_ts,
    coalesce(blank_null(vehicle_id), blank_null(vehicle_label)) AS vehicle_id,
    blank_null(trip_id)    AS trip_id,
    blank_null(route_id)   AS route_id,
    CAST(direction_id AS INTEGER) AS direction_id,
    gtfs_date(start_date)  AS reported_start_date,
    blank_null(start_time) AS reported_start_time,
    coalesce(schedule_relationship, 0) AS schedule_relationship,
    CAST(latitude AS DOUBLE)  AS lat,
    CAST(longitude AS DOUBLE) AS lon,
    bearing,
    speed,
    CAST(current_stop_sequence AS INTEGER) AS current_stop_sequence,
    blank_null(stop_id) AS stop_id,
    current_status,
    occupancy_status
  FROM raw_vehicle_position
  WHERE NOT coalesce(is_deleted, false)
)
SELECT
  t.*,
  -- Service date: see rt_service_date. The event is the report time and its
  -- scheduled offset is the middle of the trip. NULL when no trip is assigned.
  CASE WHEN t.trip_id IS NOT NULL THEN
    rt_service_date(t.reported_start_date, t.position_ts, (o.start_secs + o.end_secs) / 2, z.timezone) END AS service_date,
  CASE WHEN t.trip_id IS NOT NULL THEN
    rt_service_date_basis(t.reported_start_date, t.position_ts, (o.start_secs + o.end_secs) / 2, z.timezone) END AS service_date_basis
FROM typed t
JOIN int_system_timezone z USING (system_key)
LEFT JOIN int_trip_offset o USING (system_key, trip_id)
WHERE t.vehicle_id IS NOT NULL
  AND t.lat BETWEEN -90 AND 90 AND t.lon BETWEEN -180 AND 180
  AND NOT (t.lat = 0 AND t.lon = 0)
QUALIFY row_number() OVER (
  PARTITION BY t.system_key, t.vehicle_id, t.trip_id, t.reported_start_date, t.position_ts
  ORDER BY t.fetch_ts) = 1;

CREATE OR REPLACE TABLE qa_vehicle_position_funnel AS
WITH raw AS (
  SELECT system_key,
    count(*) AS archive_rows,
    count(*) FILTER (WHERE coalesce(is_deleted, false)) AS deleted_rows,
    count(*) FILTER (WHERE coalesce(blank_null(vehicle_id), blank_null(vehicle_label)) IS NULL) AS no_vehicle_id,
    count(*) FILTER (WHERE latitude IS NULL OR longitude IS NULL
                        OR NOT (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180)
                        OR (latitude = 0 AND longitude = 0)) AS unusable_coordinates,
    count(*) FILTER (WHERE blank_null(trip_id) IS NULL) AS no_trip_assigned,
    count(*) FILTER (WHERE nullif("timestamp", 0) IS NULL) AS no_report_time,
    count(*) FILTER (WHERE incrementality = 1) AS differential_rows
  FROM raw_vehicle_position GROUP BY ALL
),
kept AS (
  SELECT system_key, count(*) AS distinct_reports,
         count(*) FILTER (WHERE trip_id IS NOT NULL) AS distinct_reports_with_trip
  FROM stg_vehicle_position GROUP BY ALL
)
SELECT r.*, k.distinct_reports, k.distinct_reports_with_trip,
       r.archive_rows - r.deleted_rows - k.distinct_reports AS dropped_or_repeated_rows
FROM raw r
LEFT JOIN kept k USING (system_key);

-- ---------------------------------------------------------------------------
-- Trip updates. A day is tens of millions of rows, nearly all of them the
-- same prediction repeated every capture, so nothing is copied row for row.
-- Each row is first given a service date (see rt_service_date), because many
-- feeds leave start_date blank and the same trip_id runs every day. Rows whose
-- trip belongs to a service day outside the build are left out. Two
-- reductions are kept:
--   int_tu_trip  what the feed said about each trip as a whole
--   int_tu_stop  for each stop of each trip, when it was in the feed and the
--                last time the feed gave for it
-- ---------------------------------------------------------------------------
--
-- DUPLICATED trips (schedule_relationship 6). The spec puts the trip being
-- copied in trip_id and the new run in trip_properties (trip_id, start_date,
-- start_time). Each run is its own trip here: trip_id is the new run's id,
-- duplicated_from_trip_id the original, and the reported date and start time
-- are the new run's. Without this a copy's predictions merge into the
-- original trip's stops, and its date is checked against the wrong times.
--
-- Scheduled offset used to check or infer the date, first that applies:
--   stop_sequence  the row's (trip_id, stop_sequence) is in the schedule and,
--                  when the row gives a stop_id, it is the scheduled stop there
--   stop_id        else the row's stop_id, when the trip serves it once. For
--                  feeds that omit stop_sequence, or renumber on a detour
--   trip_start     else the trip's scheduled start (trip-level rows, detour
--                  stops, sequence placeholders such as 0)
--   start_time     else the row's own start_time, for trips the schedule
--                  lacks (added and duplicated runs)
-- The basis is kept in schedule_offset_basis.
CREATE OR REPLACE VIEW raw_trip_update_dated AS
WITH r AS (
  SELECT
    u.system_key,
    u.fetch_timestamp AS fetch_ts,
    CASE WHEN u.schedule_relationship = 6 AND blank_null(u.trip_properties_trip_id) IS NOT NULL
         THEN blank_null(u.trip_properties_trip_id) ELSE blank_null(u.trip_id) END AS trip_id,
    CASE WHEN u.schedule_relationship = 6 AND blank_null(u.trip_properties_trip_id) IS NOT NULL
         THEN blank_null(u.trip_id) END AS duplicated_from_trip_id,
    CASE WHEN u.schedule_relationship = 6 AND blank_null(u.trip_properties_trip_id) IS NOT NULL
         THEN coalesce(gtfs_date(u.trip_properties_start_date), gtfs_date(u.start_date))
         ELSE gtfs_date(u.start_date) END AS reported_start_date,
    CASE WHEN u.schedule_relationship = 6 AND blank_null(u.trip_properties_trip_id) IS NOT NULL
         THEN coalesce(blank_null(u.trip_properties_start_time), blank_null(u.start_time))
         ELSE blank_null(u.start_time) END AS reported_start_time,
    blank_null(u.route_id) AS route_id,
    CAST(u.direction_id AS INTEGER) AS direction_id,
    coalesce(u.schedule_relationship, 0) AS schedule_relationship,
    blank_null(u.vehicle_id) AS vehicle_id,
    u.trip_delay,
    CAST(u.stop_sequence AS INTEGER) AS stop_sequence,
    blank_null(u.stop_id) AS stop_id,
    nullif(u.arrival_time, 0) AS arrival_epoch,
    nullif(u.departure_time, 0) AS departure_epoch,
    u.arrival_delay,
    u.departure_delay,
    coalesce(u.stop_schedule_relationship, 0) AS stop_relationship,
    z.timezone
  FROM raw_trip_update u
  JOIN int_system_timezone z USING (system_key)
  WHERE NOT coalesce(u.is_deleted, false) AND blank_null(u.trip_id) IS NOT NULL
),
j AS (
  SELECT r.*,
    -- Event instant and its scheduled offset: the stop's given time against
    -- the stop's scheduled time, else the capture against the trip's start.
    coalesce(to_timestamp(coalesce(r.arrival_epoch, r.departure_epoch)), r.fetch_ts) AS evt,
    CASE WHEN so.arrival_secs IS NOT NULL THEN so.arrival_secs
         WHEN sb.arrival_secs IS NOT NULL THEN sb.arrival_secs
         WHEN o.start_secs IS NOT NULL THEN o.start_secs
         ELSE gtfs_secs(r.reported_start_time) END AS secs,
    CASE WHEN so.arrival_secs IS NOT NULL THEN 'stop_sequence'
         WHEN sb.arrival_secs IS NOT NULL THEN 'stop_id'
         WHEN o.start_secs IS NOT NULL THEN 'trip_start'
         WHEN gtfs_secs(r.reported_start_time) IS NOT NULL THEN 'start_time' END AS schedule_offset_basis
  FROM r
  LEFT JOIN int_trip_stop_offset so
    ON so.system_key = r.system_key AND so.trip_id = r.trip_id AND so.stop_sequence = r.stop_sequence
   AND (r.stop_id IS NULL OR so.stop_id = r.stop_id)
  LEFT JOIN int_trip_stop_offset_by_stop sb
    ON sb.system_key = r.system_key AND sb.trip_id = r.trip_id AND sb.stop_id = r.stop_id
  LEFT JOIN int_trip_offset o
    ON o.system_key = r.system_key AND o.trip_id = r.trip_id
)
SELECT j.* EXCLUDE (evt, secs),
  rt_service_date(reported_start_date, evt, secs, timezone)       AS service_date,
  rt_service_date_basis(reported_start_date, evt, secs, timezone) AS service_date_basis
FROM j;

CREATE OR REPLACE TABLE int_tu_trip AS
SELECT
  u.system_key,
  u.service_date,
  u.trip_id,
  mode(u.service_date_basis) AS service_date_basis,
  bool_or(u.reported_start_date IS NOT NULL) AS has_reported_start_date,
  min(u.fetch_ts) AS first_seen_ts,
  max(u.fetch_ts) AS last_seen_ts,
  count(DISTINCT u.fetch_ts) AS n_polls,
  arg_max(u.route_id, u.fetch_ts)            AS route_id,
  arg_max(u.direction_id, u.fetch_ts)        AS direction_id,
  arg_max(u.reported_start_time, u.fetch_ts) AS reported_start_time,
  arg_max(u.schedule_relationship, u.fetch_ts) AS last_schedule_relationship,
  list_sort(list(DISTINCT u.schedule_relationship)) AS schedule_relationships_seen,
  min(u.fetch_ts) FILTER (WHERE u.schedule_relationship = 3) AS first_canceled_ts,
  max(u.fetch_ts) FILTER (WHERE u.schedule_relationship = 3) AS last_canceled_ts,
  count(DISTINCT u.fetch_ts) FILTER (WHERE u.schedule_relationship = 3) AS n_polls_canceled,
  list_sort(list(DISTINCT u.vehicle_id) FILTER (WHERE u.vehicle_id IS NOT NULL)) AS vehicle_ids,
  count(*) FILTER (WHERE u.stop_id IS NOT NULL OR u.stop_sequence IS NOT NULL) AS n_stop_rows,
  count(*) FILTER (WHERE coalesce(u.arrival_epoch, u.departure_epoch) IS NOT NULL) AS n_rows_with_time,
  count(*) FILTER (WHERE coalesce(u.arrival_delay, u.departure_delay) IS NOT NULL) AS n_rows_with_delay,
  count(*) FILTER (WHERE u.stop_sequence IS NOT NULL) AS n_rows_with_sequence,
  any_value(u.duplicated_from_trip_id) AS duplicated_from_trip_id,
  count(*) FILTER (WHERE u.stop_id IS NOT NULL) AS n_rows_with_stop_id,
  -- Stop rows whose scheduled offset came from each basis (see the view).
  count(*) FILTER (WHERE u.schedule_offset_basis = 'stop_sequence') AS n_rows_offset_by_sequence,
  count(*) FILTER (WHERE u.schedule_offset_basis = 'stop_id') AS n_rows_offset_by_stop_id
FROM raw_trip_update_dated u
JOIN dim_service_day d USING (system_key, service_date)
GROUP BY ALL;

CREATE OR REPLACE TABLE int_tu_stop AS
SELECT
  u.system_key,
  u.service_date,
  u.trip_id,
  u.stop_sequence,
  u.stop_id,
  min(u.fetch_ts) AS first_seen_ts,
  max(u.fetch_ts) AS last_seen_ts,
  count(DISTINCT u.fetch_ts) AS n_polls,
  -- Values from the last capture that carried this stop.
  arg_max(u.arrival_epoch, u.fetch_ts)     AS last_arrival_epoch,
  arg_max(u.departure_epoch, u.fetch_ts)   AS last_departure_epoch,
  arg_max(u.arrival_delay, u.fetch_ts)     AS last_arrival_delay,
  arg_max(u.departure_delay, u.fetch_ts)   AS last_departure_delay,
  arg_max(u.trip_delay, u.fetch_ts)        AS last_trip_delay,
  arg_max(u.stop_relationship, u.fetch_ts) AS last_stop_relationship,
  bool_or(u.stop_relationship = 1)         AS ever_skipped,
  arg_max(u.vehicle_id, u.fetch_ts)        AS last_vehicle_id,
  count(DISTINCT coalesce(u.arrival_epoch, u.departure_epoch)) AS n_distinct_times,
  -- How this stop was placed on the schedule for dating; the same for every
  -- row of one stop key. stop_sequence and stop_id above are the feed's own.
  min(u.schedule_offset_basis) AS schedule_offset_basis
FROM raw_trip_update_dated u
JOIN dim_service_day d USING (system_key, service_date)
WHERE u.stop_sequence IS NOT NULL OR u.stop_id IS NOT NULL
GROUP BY ALL;

-- ---------------------------------------------------------------------------
-- stg_alert: one row per alert, content version and informed entity, with
-- the captures it was present in. Content is the alert's cause, effect,
-- header, description and active period; an edit starts a new version.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE TABLE stg_alert AS
SELECT
  system_key,
  entity_id AS alert_id,
  md5(concat_ws('|', cause, effect, severity_level, header_text, description_text)) AS content_hash,
  cause, effect, severity_level,
  header_text, description_text,
  to_timestamp(nullif(active_period_start, 0)) AS active_start_ts,
  to_timestamp(nullif(active_period_end, 0))   AS active_end_ts,
  blank_null(agency_id) AS informed_agency_id,
  coalesce(blank_null(route_id), blank_null(trip_route_id)) AS informed_route_id,
  route_type AS informed_route_type,
  CAST(direction_id AS INTEGER) AS informed_direction_id,
  blank_null(stop_id) AS informed_stop_id,
  blank_null(trip_id) AS informed_trip_id,
  gtfs_date(trip_start_date) AS informed_trip_start_date,
  trip_schedule_relationship AS informed_trip_relationship,
  min(fetch_timestamp) AS first_seen_ts,
  max(fetch_timestamp) AS last_seen_ts,
  count(DISTINCT fetch_timestamp) AS n_polls
FROM raw_service_alert
WHERE NOT coalesce(is_deleted, false)
GROUP BY ALL;

-- ---------------------------------------------------------------------------
-- Feed QA for staging. These record what each feed actually provides, and
-- which of the general rules above applied to it, so that a reader can see
-- why a feed's numbers look the way they do.
-- ---------------------------------------------------------------------------

-- qa_tu_feed_profile: one row per system and service date.
--   stop_reference  what the feed uses to name a stop: 'both', 'stop_sequence
--                   only' or 'stop_id only' (judged on the majority of rows)
--   time_basis      'absolute' (arrival/departure times), 'delay' (delays only:
--                   the predicted time is the scheduled time on the service
--                   date plus the delay, so it is only as right as the date),
--                   'both', or 'none'
--   share_offset_*  share of stop rows placed on the schedule by each basis of
--                   raw_trip_update_dated; the rest fell back to the trip
--   duplicated_runs DUPLICATED runs split off their original trip_id
CREATE OR REPLACE TABLE qa_tu_feed_profile AS
WITH t AS (
  SELECT system_key, service_date,
    count(*) AS n_trips,
    count(*) FILTER (WHERE duplicated_from_trip_id IS NOT NULL) AS duplicated_runs,
    count(*) FILTER (WHERE has_reported_start_date) AS n_trips_with_start_date,
    sum(n_stop_rows) AS stop_rows,
    sum(n_rows_with_sequence) AS rows_with_sequence,
    sum(n_rows_with_stop_id) AS rows_with_stop_id,
    sum(n_rows_with_time) AS rows_with_time,
    sum(n_rows_with_delay) AS rows_with_delay,
    sum(n_rows_offset_by_sequence) AS rows_offset_by_sequence,
    sum(n_rows_offset_by_stop_id) AS rows_offset_by_stop_id
  FROM int_tu_trip
  GROUP BY ALL
)
SELECT
  t.*,
  CASE WHEN t.stop_rows = 0 THEN 'none'
       WHEN t.rows_with_sequence >= 0.5 * t.stop_rows AND t.rows_with_stop_id >= 0.5 * t.stop_rows THEN 'both'
       WHEN t.rows_with_sequence >= 0.5 * t.stop_rows THEN 'stop_sequence only'
       ELSE 'stop_id only' END AS stop_reference,
  CASE WHEN t.stop_rows = 0 THEN 'none'
       WHEN t.rows_with_time >= 0.5 * t.stop_rows AND t.rows_with_delay >= 0.5 * t.stop_rows THEN 'both'
       WHEN t.rows_with_time >= 0.5 * t.stop_rows THEN 'absolute'
       WHEN t.rows_with_delay >= 0.5 * t.stop_rows THEN 'delay'
       ELSE 'none' END AS time_basis,
  round(t.rows_offset_by_sequence / nullif(t.stop_rows, 0), 4) AS share_offset_by_sequence,
  round(t.rows_offset_by_stop_id / nullif(t.stop_rows, 0), 4)  AS share_offset_by_stop_id
FROM t;

-- qa_trip_id_match: one row per feed type, system, service date and trip_id
-- shape (digits collapsed to '#', first 12 characters). How many of the
-- realtime trip_ids the schedule knows on the resolved date, and from which
-- schedule source. A shape that never matches is either another operator's
-- trips (see cat_schedule_extra) or an ID format the schedule does not use.
CREATE OR REPLACE TABLE qa_trip_id_match AS
WITH rt AS (
  SELECT DISTINCT 'vehicle_positions' AS feed_type, v.system_key, v.service_date, v.trip_id
  FROM stg_vehicle_position v
  JOIN dim_service_day d USING (system_key, service_date)
  WHERE v.trip_id IS NOT NULL
  UNION ALL
  SELECT DISTINCT 'trip_updates', system_key, service_date, trip_id
  FROM int_tu_trip
)
SELECT
  rt.feed_type, rt.system_key, rt.service_date,
  left(regexp_replace(rt.trip_id, '[0-9]+', '#', 'g'), 12) AS trip_id_shape,
  count(*) AS n_trip_ids,
  count(f.trip_id) AS n_matched_on_date,
  count(o.trip_id) AS n_in_build_schedule,
  round(count(f.trip_id) / count(*), 4) AS share_matched,
  list(DISTINCT f.schedule_url) FILTER (WHERE f.schedule_url IS NOT NULL) AS schedule_urls,
  min(rt.trip_id) AS example_trip_id
FROM rt
LEFT JOIN fct_scheduled_trip f USING (system_key, service_date, trip_id)
LEFT JOIN int_trip_offset o USING (system_key, trip_id)
GROUP BY ALL;

-- qa_scheduled_trip_presence: one row per system and service date. Scheduled
-- trips by whether either realtime feed ever mentioned them. A trip in trip
-- updates is not necessarily one that ran: some feeds list future trips, or
-- carry them only to cancel them or skip stops.
CREATE OR REPLACE TABLE qa_scheduled_trip_presence AS
WITH vp AS (SELECT DISTINCT system_key, service_date, trip_id FROM stg_vehicle_position WHERE trip_id IS NOT NULL)
SELECT
  s.system_key, s.service_date,
  count(*) AS n_scheduled,
  count(tu.trip_id) AS n_in_trip_updates,
  count(tu.trip_id) FILTER (WHERE tu.vehicle_ids <> [] OR tu.n_rows_with_time > 0 OR tu.n_rows_with_delay > 0)
    AS n_in_trip_updates_with_vehicle_or_time,
  count(vp.trip_id) AS n_in_vehicle_positions,
  count(*) FILTER (WHERE tu.trip_id IS NULL AND vp.trip_id IS NULL) AS n_in_neither
FROM fct_scheduled_trip s
LEFT JOIN int_tu_trip tu USING (system_key, service_date, trip_id)
LEFT JOIN vp USING (system_key, service_date, trip_id)
GROUP BY ALL;
