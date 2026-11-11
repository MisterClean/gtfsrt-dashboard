-- Service alerts. The archive repeats every alert at every capture; these
-- tables state each alert once, with the span over which the feed carried it.

-- fct_alert: one row per system, alert id and content version. An edit to an
-- alert's cause, effect, severity or text starts a new version.
--   first_seen_ts / last_seen_ts  first and last capture that carried it
--   active_start_ts / active_end_ts  earliest start and latest end over its
--       active periods; NULL means open-ended on that side
CREATE OR REPLACE TABLE fct_alert AS
SELECT
  system_key,
  alert_id,
  content_hash,
  enum_label('alert_cause', any_value(cause))   AS cause,
  enum_label('alert_effect', any_value(effect)) AS effect,
  any_value(severity_level)   AS severity_level,
  any_value(header_text)      AS header_text,
  any_value(description_text) AS description_text,
  min(first_seen_ts) AS first_seen_ts,
  max(last_seen_ts)  AS last_seen_ts,
  max(n_polls)       AS n_polls,
  CASE WHEN bool_or(active_start_ts IS NULL) THEN NULL ELSE min(active_start_ts) END AS active_start_ts,
  CASE WHEN bool_or(active_end_ts IS NULL) THEN NULL ELSE max(active_end_ts) END     AS active_end_ts,
  count(DISTINCT informed_route_id) AS n_routes,
  count(DISTINCT informed_stop_id)  AS n_stops,
  count(DISTINCT informed_trip_id)  AS n_trips,
  bool_or(informed_route_id IS NULL AND informed_stop_id IS NULL AND informed_trip_id IS NULL) AS informs_whole_agency
FROM stg_alert
GROUP BY system_key, alert_id, content_hash;

-- fct_alert_entity: one row per alert version and informed entity.
CREATE OR REPLACE TABLE fct_alert_entity AS
SELECT DISTINCT
  system_key, alert_id, content_hash,
  informed_agency_id, informed_route_id, informed_route_type, informed_direction_id,
  informed_stop_id, informed_trip_id, informed_trip_start_date, informed_trip_relationship
FROM stg_alert;

-- fct_alert_route_day: one row per system, service date, route and effect.
-- Seconds of the service span during which at least one alert with that
-- effect, informing that route (directly or through one of its trips), was
-- both carried by the feed and inside its own active period.
CREATE OR REPLACE TABLE fct_alert_route_day AS
WITH live AS (
  SELECT
    a.system_key, s.service_date, a.alert_id, a.content_hash, a.effect,
    greatest(a.first_seen_ts, coalesce(a.active_start_ts, a.first_seen_ts), s.span_start_ts) AS live_start_ts,
    least(a.last_seen_ts, coalesce(a.active_end_ts, a.last_seen_ts), s.span_end_ts)          AS live_end_ts
  FROM fct_alert a
  JOIN int_service_span s USING (system_key)
),
routed AS (
  SELECT DISTINCT l.system_key, l.service_date, l.effect, l.alert_id, l.live_start_ts, l.live_end_ts,
         coalesce(e.informed_route_id, t.route_id) AS route_id
  FROM live l
  JOIN fct_alert_entity e USING (system_key, alert_id, content_hash)
  LEFT JOIN fct_scheduled_trip t
    ON t.system_key = l.system_key AND t.service_date = l.service_date AND t.trip_id = e.informed_trip_id
  WHERE l.live_end_ts > l.live_start_ts
),
-- Merge overlapping alert spans per route and effect so time is not counted twice.
marked AS (
  SELECT *,
    CASE WHEN live_start_ts <= max(live_end_ts) OVER (
           PARTITION BY system_key, service_date, route_id, effect ORDER BY live_start_ts, live_end_ts
           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) THEN 0 ELSE 1 END AS starts_island
  FROM routed
  WHERE route_id IS NOT NULL
),
islands AS (
  SELECT *, sum(starts_island) OVER (
    PARTITION BY system_key, service_date, route_id, effect ORDER BY live_start_ts, live_end_ts) AS island
  FROM marked
),
merged AS (
  SELECT system_key, service_date, route_id, effect, island,
         min(live_start_ts) AS start_ts, max(live_end_ts) AS end_ts, count(DISTINCT alert_id) AS alerts
  FROM islands
  GROUP BY ALL
)
SELECT system_key, service_date, route_id, effect,
       sum(epoch(end_ts) - epoch(start_ts)) AS alert_s,
       sum(alerts) AS alerts
FROM merged
GROUP BY ALL;
