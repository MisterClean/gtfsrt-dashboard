-- Headways: the time between consecutive vehicles at a stop, on one route and
-- direction, against the scheduled headway at that point.
--
-- fct_headway: one row per system, service date, route, direction, stop and
-- observed trip (the later vehicle of each pair).
--
-- Rules
--   * The observed headway is the gap to the previous observed vehicle at the
--     stop on the same route and direction, by event time.
--   * The scheduled headway is the gap between this trip's scheduled time at
--     the stop and the previous scheduled trip's, over the full schedule for
--     the day. Comparing with the spacing of the two observed trips would
--     hide a missing trip, which is exactly the wait riders notice.
--   * A trip's last stop is left out of both. On a loop it is also the first
--     stop, and the gap between an arrival and the next departure is layover.
--   * A trip that serves a stop twice uses its first pass only.
--   * The same vehicle returning is not a headway.
--   * A gap longer than both an hour and four scheduled headways is dropped as
--     unobserved passes, not a wait (is_valid = false). This removes the
--     longest real waits too, so gap shares are a floor.
--   * Frequent service is a scheduled headway of frequent_headway_s or less.
CREATE OR REPLACE TABLE fct_headway AS
WITH passes AS (
  -- First pass of each scheduled trip at each stop, last stops excluded.
  SELECT *
  FROM fct_stop_event
  WHERE is_scheduled AND NOT is_last_stop AND route_id IS NOT NULL
  QUALIFY row_number() OVER (
    PARTITION BY system_key, service_date, trip_id, stop_id ORDER BY stop_sequence) = 1
),
sched AS (
  SELECT system_key, service_date, trip_id, stop_id,
    epoch(scheduled_departure_ts) - epoch(lag(scheduled_departure_ts) OVER w) AS scheduled_headway_s,
    lag(trip_id) OVER w AS scheduled_prev_trip_id
  FROM passes
  WINDOW w AS (PARTITION BY system_key, service_date, route_id, direction_id, stop_id
               ORDER BY scheduled_departure_ts, trip_id)
),
obs AS (
  SELECT system_key, service_date, route_id, direction_id, stop_id, trip_id, stop_sequence,
    event_method, vehicle_id, event_ts, in_slice,
    lag(event_ts) OVER w   AS prev_event_ts,
    lag(trip_id) OVER w    AS prev_trip_id,
    lag(vehicle_id) OVER w AS prev_vehicle_id,
    lag(event_method) OVER w AS prev_event_method
  FROM passes
  WHERE event_ts IS NOT NULL
  WINDOW w AS (PARTITION BY system_key, service_date, route_id, direction_id, stop_id
               ORDER BY event_ts, trip_id)
)
SELECT
  o.system_key, o.service_date, o.route_id, o.direction_id, o.stop_id, o.trip_id, o.stop_sequence,
  o.event_ts,
  o.prev_trip_id,
  o.event_method,
  -- Both ends of a headway must come from one method; mixing them would put
  -- the methods' offset into the headway.
  o.event_method = o.prev_event_method AS same_method,
  epoch(o.event_ts) - epoch(o.prev_event_ts) AS observed_headway_s,
  s.scheduled_headway_s,
  s.scheduled_prev_trip_id,
  s.scheduled_headway_s <= threshold('frequent_headway_s') AS is_frequent,
  o.vehicle_id IS NOT NULL AND o.vehicle_id = o.prev_vehicle_id AS is_same_vehicle,
  o.in_slice,
  o.prev_event_ts IS NOT NULL
    AND s.scheduled_headway_s > 0
    AND o.event_method = o.prev_event_method
    AND NOT (o.vehicle_id IS NOT NULL AND o.vehicle_id IS NOT DISTINCT FROM o.prev_vehicle_id)
    AND NOT (epoch(o.event_ts) - epoch(o.prev_event_ts) > 3600
             AND epoch(o.event_ts) - epoch(o.prev_event_ts) > 4 * s.scheduled_headway_s) AS is_valid
FROM obs o
JOIN sched s USING (system_key, service_date, trip_id, stop_id)
WHERE o.prev_event_ts IS NOT NULL AND s.scheduled_headway_s IS NOT NULL;
