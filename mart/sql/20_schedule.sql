-- Schedule facts: what was supposed to run on each service day.
-- Grain is stated on every table and enforced in mart/tests.

-- dim_service_day: one row per system and service date.
-- Time zone is the schedule's agency_timezone. The read window runs from one
-- hour before the service-day origin (to keep early predictions) to 30 hours
-- after it; a thin slice narrows both ends.
CREATE OR REPLACE TABLE dim_service_day AS
WITH tz AS (
  SELECT p.system_key, p.service_date, min(a.agency_timezone) AS timezone,
         count(DISTINCT a.agency_timezone) AS n_timezones
  FROM plan_schedule p
  LEFT JOIN stg_agency a
    ON a.feed_digest = p.feed_digest
   AND (p.agency_ids IS NULL OR a.agency_id IS NULL OR list_contains(p.agency_ids, a.agency_id))
  GROUP BY ALL
),
basis AS (
  SELECT system_key, service_date,
         CASE WHEN bool_or(schedule_basis = 'none') THEN 'none'
              WHEN bool_or(schedule_basis = 'captured_later') THEN 'captured_later'
              ELSE 'in_force' END AS schedule_basis,
         list(feed_digest ORDER BY schedule_url) AS feed_digests
  FROM plan_schedule
  GROUP BY ALL
)
SELECT
  b.system_key,
  b.service_date,
  tz.timezone,
  b.schedule_basis,
  b.feed_digests,
  service_origin(b.service_date, tz.timezone) AS origin_ts,
  service_ts(b.service_date, getvariable('slice_start_hour') * 3600, tz.timezone) AS slice_start_ts,
  service_ts(b.service_date, getvariable('slice_end_hour') * 3600, tz.timezone)   AS slice_end_ts,
  service_ts(b.service_date, getvariable('slice_start_hour') * 3600, tz.timezone)
    - to_hours(CAST(threshold('prediction_lead_hours') AS INTEGER))               AS read_start_ts,
  service_ts(b.service_date, getvariable('slice_end_hour') * 3600, tz.timezone)   AS read_end_ts,
  getvariable('slice_start_hour') > 0 OR getvariable('slice_end_hour') < 30       AS is_slice
FROM basis b
JOIN tz USING (system_key, service_date);

-- int_service_active: service_ids running on each service day, from calendar
-- weekdays within their date range, plus calendar_dates additions (1), minus
-- removals (2).
CREATE OR REPLACE TABLE int_service_active AS
WITH base AS (
  SELECT p.system_key, p.service_date, p.feed_digest, c.service_id
  FROM plan_schedule p
  JOIN stg_calendar c USING (feed_digest)
  WHERE p.service_date BETWEEN c.start_date AND c.end_date
    AND c.runs_on_dow[dayofweek(p.service_date) + 1]
  UNION
  SELECT p.system_key, p.service_date, p.feed_digest, x.service_id
  FROM plan_schedule p
  JOIN stg_calendar_dates x USING (feed_digest, service_date)
  WHERE x.exception_type = 1
)
SELECT b.*
FROM base b
ANTI JOIN (SELECT feed_digest, service_date, service_id FROM stg_calendar_dates WHERE exception_type = 2) r
  USING (feed_digest, service_date, service_id);

-- int_stop_time: stop times per schedule version with blank times filled.
-- A blank time is interpolated by straight-line distance between the stops
-- with known times either side, and flagged. Arrival falls back to departure
-- and departure to arrival when only one is given.
CREATE OR REPLACE TABLE int_stop_time AS
WITH st AS (
  SELECT
    t.feed_digest, t.trip_id, t.stop_sequence, t.stop_id, t.timepoint,
    t.pickup_type, t.drop_off_type,
    coalesce(t.arrival_secs, t.departure_secs) AS arr,
    coalesce(t.departure_secs, t.arrival_secs) AS dep,
    s.stop_lat, s.stop_lon
  FROM stg_stop_times t
  LEFT JOIN stg_stops s USING (feed_digest, stop_id)
),
hop AS (
  SELECT *,
    coalesce(haversine_m(
      lag(stop_lat) OVER w, lag(stop_lon) OVER w, stop_lat, stop_lon), 0) AS hop_m
  FROM st
  WINDOW w AS (PARTITION BY feed_digest, trip_id ORDER BY stop_sequence)
),
cum AS (
  SELECT *,
    sum(hop_m) OVER (PARTITION BY feed_digest, trip_id ORDER BY stop_sequence) AS cum_m
  FROM hop
),
anchors AS (
  SELECT *,
    last_value(dep IGNORE NULLS) OVER prev  AS prev_dep,
    last_value(CASE WHEN dep IS NOT NULL THEN cum_m END IGNORE NULLS) OVER prev AS prev_m,
    first_value(arr IGNORE NULLS) OVER next AS next_arr,
    first_value(CASE WHEN arr IS NOT NULL THEN cum_m END IGNORE NULLS) OVER next AS next_m
  FROM cum
  WINDOW prev AS (PARTITION BY feed_digest, trip_id ORDER BY stop_sequence
                  ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW),
         next AS (PARTITION BY feed_digest, trip_id ORDER BY stop_sequence
                  ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING)
),
filled AS (
  SELECT *,
    arr IS NULL AS is_time_interpolated,
    CASE WHEN arr IS NOT NULL THEN NULL
         WHEN next_m > prev_m THEN prev_dep + (next_arr - prev_dep) * (cum_m - prev_m) / (next_m - prev_m)
         ELSE prev_dep END AS interp
  FROM anchors
)
SELECT
  feed_digest, trip_id, stop_sequence, stop_id,
  CAST(round(coalesce(arr, interp)) AS INTEGER) AS arrival_secs,
  CAST(round(coalesce(dep, interp)) AS INTEGER) AS departure_secs,
  is_time_interpolated,
  timepoint,
  pickup_type, drop_off_type,
  row_number() OVER (PARTITION BY feed_digest, trip_id ORDER BY stop_sequence) AS stop_index,
  count(*) OVER (PARTITION BY feed_digest, trip_id) AS n_stops,
  -- Measured at timepoints; when a trip marks none, at every stop.
  coalesce(timepoint = 1, false)
    OR NOT coalesce(bool_or(timepoint = 1) OVER (PARTITION BY feed_digest, trip_id), false) AS is_timepoint
FROM filled;

-- fct_scheduled_trip: one row per system, service date and trip_id.
-- A schedule source limited to some agencies (plan_schedule.agency_ids, from
-- cat_schedule_extra) contributes only trips on routes of those agencies.
-- schedule_url and route_agency_id say where each trip came from.
CREATE OR REPLACE TABLE fct_scheduled_trip AS
WITH span AS (
  SELECT
    feed_digest, trip_id,
    min(departure_secs) AS start_secs,
    max(arrival_secs)   AS end_secs,
    count(*)            AS n_stops,
    count(*) FILTER (WHERE is_timepoint) AS n_timepoints,
    arg_min(stop_id, stop_sequence) AS first_stop_id,
    arg_max(stop_id, stop_sequence) AS last_stop_id
  FROM int_stop_time
  GROUP BY ALL
)
SELECT
  a.system_key,
  a.service_date,
  t.trip_id,
  a.feed_digest,
  t.route_id,
  t.direction_id,
  t.service_id,
  t.shape_id,
  t.block_id,
  t.trip_headsign,
  s.first_stop_id,
  s.last_stop_id,
  s.n_stops,
  s.n_timepoints,
  s.start_secs,
  s.end_secs,
  service_ts(a.service_date, s.start_secs, d.timezone) AS start_ts,
  service_ts(a.service_date, s.end_secs, d.timezone)   AS end_ts,
  CAST(floor(s.start_secs / 3600) AS INTEGER) AS start_hour,
  f.trip_id IS NOT NULL AS is_frequency_based,
  -- A trip is inside the slice when its whole scheduled span is.
  service_ts(a.service_date, s.start_secs, d.timezone) >= d.slice_start_ts
    AND service_ts(a.service_date, s.end_secs, d.timezone) <= d.slice_end_ts AS in_slice,
  p.schedule_url,
  r.agency_id AS route_agency_id
FROM int_service_active a
JOIN stg_trips t USING (feed_digest, service_id)
JOIN span s USING (feed_digest, trip_id)
JOIN dim_service_day d USING (system_key, service_date)
JOIN plan_schedule p USING (system_key, service_date, feed_digest)
LEFT JOIN stg_routes r USING (feed_digest, route_id)
LEFT JOIN stg_frequencies f USING (feed_digest, trip_id)
WHERE p.agency_ids IS NULL OR list_contains(p.agency_ids, r.agency_id);

-- qa_schedule_source: one row per system, service date and schedule source.
-- Which version was used, why, and how many trips it gave the day.
CREATE OR REPLACE TABLE qa_schedule_source AS
SELECT p.system_key, p.service_date, p.schedule_url, p.source_role, p.agency_ids,
       p.feed_digest, p.retrieved_at, p.schedule_basis,
       count(t.trip_id) AS n_trips
FROM plan_schedule p
LEFT JOIN fct_scheduled_trip t USING (system_key, service_date, schedule_url)
GROUP BY ALL;

-- fct_scheduled_stop_time: one row per system, service date, trip_id and
-- stop_sequence.
CREATE OR REPLACE TABLE fct_scheduled_stop_time AS
SELECT
  t.system_key,
  t.service_date,
  t.trip_id,
  s.stop_sequence,
  s.stop_index,
  s.stop_id,
  t.route_id,
  t.direction_id,
  s.arrival_secs,
  s.departure_secs,
  service_ts(t.service_date, s.arrival_secs, d.timezone)   AS arrival_ts,
  service_ts(t.service_date, s.departure_secs, d.timezone) AS departure_ts,
  s.is_time_interpolated,
  s.is_timepoint,
  s.stop_index = 1         AS is_first_stop,
  s.stop_index = s.n_stops AS is_last_stop,
  t.in_slice
FROM fct_scheduled_trip t
JOIN int_stop_time s USING (feed_digest, trip_id)
JOIN dim_service_day d USING (system_key, service_date);

-- Version-scoped dimensions. Facts carry feed_digest so names resolve against
-- the schedule that was in force.
CREATE OR REPLACE TABLE dim_route AS
SELECT DISTINCT p.system_key, r.feed_digest, r.route_id, r.route_short_name, r.route_long_name, r.route_type,
  -- 11 is trolleybus and 800-899 trolleybus service: buses on wires.
  CASE WHEN r.route_type IN (0, 5, 12) OR r.route_type BETWEEN 900 AND 999 THEN 'tram'
       WHEN r.route_type = 1 OR r.route_type BETWEEN 400 AND 499 THEN 'subway'
       WHEN r.route_type = 2 OR r.route_type BETWEEN 100 AND 199 THEN 'rail'
       WHEN r.route_type = 4 OR r.route_type BETWEEN 1000 AND 1199 THEN 'ferry'
       ELSE 'bus' END AS mode
FROM stg_routes r
JOIN plan_schedule p USING (feed_digest)
WHERE p.agency_ids IS NULL OR list_contains(p.agency_ids, r.agency_id);

CREATE OR REPLACE TABLE dim_stop AS
SELECT DISTINCT p.system_key, s.feed_digest, s.stop_id, s.stop_code, s.stop_name, s.stop_lat, s.stop_lon,
  s.location_type, s.parent_station
FROM stg_stops s
JOIN plan_schedule p USING (feed_digest);

-- Offsets used to date realtime rows before they are aggregated. A trip_id
-- keeps its times across the days of one schedule version; where versions in
-- the build disagree, the earliest service date's values are used and the
-- resolved date is checked against fct_scheduled_trip afterwards.
CREATE OR REPLACE TABLE int_trip_offset AS
SELECT system_key, trip_id,
       arg_min(start_secs, service_date) AS start_secs,
       arg_min(end_secs, service_date)   AS end_secs
FROM fct_scheduled_trip
GROUP BY ALL;

CREATE OR REPLACE TABLE int_trip_stop_offset AS
SELECT system_key, trip_id, stop_sequence,
       arg_min(stop_id, service_date)      AS stop_id,
       arg_min(arrival_secs, service_date) AS arrival_secs
FROM fct_scheduled_stop_time
GROUP BY ALL;

-- The same offsets keyed by stop_id, for feeds that omit stop_sequence or
-- renumber a trip's stops on a detour. Only stops a trip serves exactly once
-- (the rule 41_stop_event_tu uses); a stop visited twice is ambiguous by
-- stop_id alone and is left out.
CREATE OR REPLACE TABLE int_trip_stop_offset_by_stop AS
SELECT system_key, trip_id, stop_id,
       min(stop_sequence) AS stop_sequence,
       min(arrival_secs)  AS arrival_secs
FROM int_trip_stop_offset
GROUP BY ALL
HAVING count(*) = 1;

CREATE OR REPLACE TABLE int_system_timezone AS
SELECT system_key, min(timezone) AS timezone, min(service_date) AS first_service_date,
       max(service_date) AS last_service_date
FROM dim_service_day
GROUP BY ALL;
