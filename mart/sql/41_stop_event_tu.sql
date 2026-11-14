-- Stop events from trip updates.
--
-- A trip-updates feed publishes, for each stop a trip has yet to serve, the
-- time it expects to arrive. Feeds differ in what happens once the vehicle
-- gets there: some keep the stop in the feed for a while with its final time,
-- some drop it at once, some drop it early. The last time a feed gave for a
-- stop is therefore evidence of when the vehicle arrived only when the feed
-- was still carrying the stop close to that time. This model keeps the last
-- value for every stop and grades it by how far ahead of its last capture it
-- still was (lead_s):
--
--   observed       lead_s <= tu_frozen_lead_s. The feed carried the stop up
--                  to, or past, the time it gave. Used as an observed arrival.
--   near_estimate  lead_s <= tu_near_lead_s, or a delay-only value however
--                  late it was given. A prediction made at most that
--                  long before the event. Kept and labelled; used only where
--                  a model says so.
--   prediction     anything further ahead. The stop left the feed while its
--                  time was still well in the future (trip vanished, feed
--                  outage, or the feed drops stops early). Not an observation.
--   skipped        the last word on the stop was SKIPPED.
--   no_data        the last word was NO_DATA, or no time or delay was given.
--
-- These are a feed's statements, not measurements. They are a separate method
-- from vehicle-position events and are never mixed with them unlabelled.
--
-- fct_stop_event_tu: one row per system, service date, trip_id and
-- stop_sequence that the feed mentioned.

CREATE OR REPLACE TABLE fct_stop_event_tu AS
WITH sched_trip AS (
  SELECT DISTINCT system_key, service_date, trip_id FROM fct_scheduled_trip
),
-- Stops that appear exactly once in a scheduled trip can be matched by stop_id.
uniq_stop AS (
  SELECT system_key, service_date, trip_id, stop_id, min(stop_sequence) AS stop_sequence
  FROM fct_scheduled_stop_time
  GROUP BY ALL
  HAVING count(*) = 1
),
-- Which scheduled stop a feed row is about.
--   sequence   the feed's stop_sequence exists in the schedule and its stop_id
--              (when given) is the scheduled stop there
--   stop_id    otherwise, the feed's stop_id occurs exactly once in the trip.
--              Covers feeds that omit stop_sequence, and feeds that renumber a
--              trip's stops when a detour drops or inserts some.
--   none       a stop the scheduled trip does not have (a temporary detour
--              stop), or a stop on a trip the schedule does not have
resolved AS (
  SELECT
    l.*,
    t.trip_id IS NOT NULL AS trip_is_scheduled,
    CASE WHEN s1.stop_id IS NOT NULL AND (l.stop_id IS NULL OR l.stop_id = s1.stop_id) THEN 'sequence'
         WHEN s2.stop_sequence IS NOT NULL THEN 'stop_id'
         ELSE 'none' END AS stop_match,
    CASE WHEN s1.stop_id IS NOT NULL AND (l.stop_id IS NULL OR l.stop_id = s1.stop_id) THEN s1.stop_sequence
         WHEN s2.stop_sequence IS NOT NULL THEN s2.stop_sequence
         WHEN t.trip_id IS NULL THEN l.stop_sequence END AS resolved_sequence
  FROM int_tu_stop l
  LEFT JOIN sched_trip t USING (system_key, service_date, trip_id)
  LEFT JOIN fct_scheduled_stop_time s1
    ON s1.system_key = l.system_key AND s1.service_date = l.service_date AND s1.trip_id = l.trip_id
   AND s1.stop_sequence = l.stop_sequence
  LEFT JOIN uniq_stop s2
    ON s2.system_key = l.system_key AND s2.service_date = l.service_date AND s2.trip_id = l.trip_id
   AND s2.stop_id = l.stop_id
),
latest AS (
  -- One row per resolved stop. Stops of a scheduled trip that match nothing
  -- in it are left out (counted in qa_stop_event_tu_evidence). When several
  -- feed rows resolve to one stop, a sequence match wins, then the latest.
  SELECT *
  FROM resolved
  WHERE resolved_sequence IS NOT NULL
  QUALIFY row_number() OVER (
    PARTITION BY system_key, service_date, trip_id, resolved_sequence
    ORDER BY (stop_match = 'sequence') DESC, last_seen_ts DESC, n_polls DESC) = 1
),
joined AS (
  SELECT
    l.system_key,
    l.service_date,
    l.trip_id,
    l.resolved_sequence AS stop_sequence,
    coalesce(s.stop_id, l.stop_id) AS stop_id,
    s.stop_id IS NOT NULL AS is_scheduled_stop,
    l.stop_match,
    l.stop_sequence AS feed_stop_sequence,
    s.arrival_ts   AS scheduled_arrival_ts,
    s.departure_ts AS scheduled_departure_ts,
    -- An absolute time when given; else the scheduled time plus the delay.
    coalesce(to_timestamp(l.last_arrival_epoch),
             s.arrival_ts + to_seconds(l.last_arrival_delay),
             to_timestamp(l.last_departure_epoch),
             s.departure_ts + to_seconds(l.last_departure_delay)) AS arrival_ts,
    coalesce(to_timestamp(l.last_departure_epoch),
             s.departure_ts + to_seconds(l.last_departure_delay),
             to_timestamp(l.last_arrival_epoch),
             s.arrival_ts + to_seconds(l.last_arrival_delay)) AS departure_ts,
    CASE WHEN l.last_arrival_epoch IS NOT NULL OR l.last_departure_epoch IS NOT NULL THEN 'time'
         WHEN l.last_arrival_delay IS NOT NULL OR l.last_departure_delay IS NOT NULL THEN 'delay'
         END AS time_basis,
    l.first_seen_ts,
    l.last_seen_ts,
    l.n_polls,
    l.n_distinct_times,
    l.last_stop_relationship,
    l.ever_skipped,
    l.last_vehicle_id AS vehicle_id
  FROM latest l
  LEFT JOIN fct_scheduled_stop_time s
    ON s.system_key = l.system_key AND s.service_date = l.service_date AND s.trip_id = l.trip_id
   AND s.stop_sequence = l.resolved_sequence
)
SELECT
  j.* REPLACE (
    -- A departure given as earlier than the arrival is not believed (some
    -- feeds put a placeholder there at a trip's last stop); the arrival
    -- stands for both.
    CASE WHEN j.departure_ts < j.arrival_ts THEN j.arrival_ts ELSE j.departure_ts END AS departure_ts),
  j.departure_ts < j.arrival_ts AS departure_before_arrival,
  epoch(j.arrival_ts) - epoch(j.last_seen_ts) AS lead_s,
  CASE
    WHEN j.last_stop_relationship = 1 THEN 'skipped'
    WHEN j.last_stop_relationship = 2 OR j.arrival_ts IS NULL THEN 'no_data'
    -- A delay is not a time: a feed that gives only a delay against the
    -- schedule states how late the vehicle is running, usually rounded, not
    -- when it reached the stop. Such a stop is never graded above an estimate.
    WHEN j.time_basis = 'delay'
     AND epoch(j.arrival_ts) - epoch(j.last_seen_ts) <= threshold('tu_near_lead_s') THEN 'near_estimate'
    WHEN epoch(j.arrival_ts) - epoch(j.last_seen_ts) <= threshold('tu_frozen_lead_s') THEN 'observed'
    WHEN epoch(j.arrival_ts) - epoch(j.last_seen_ts) <= threshold('tu_near_lead_s') THEN 'near_estimate'
    ELSE 'prediction'
  END AS evidence
FROM joined j;

-- qa_stop_event_tu_evidence: one row per system and service date. How the
-- feed's last words on stops split by evidence grade. A feed whose stops are
-- mostly 'prediction' cannot support stop events from trip updates.
CREATE OR REPLACE TABLE qa_stop_event_tu_evidence AS
SELECT system_key, service_date,
  count(*) AS trip_stops,
  count(*) FILTER (WHERE evidence = 'observed')      AS observed,
  count(*) FILTER (WHERE evidence = 'near_estimate') AS near_estimate,
  count(*) FILTER (WHERE evidence = 'prediction')    AS prediction,
  count(*) FILTER (WHERE evidence = 'skipped')       AS skipped,
  count(*) FILTER (WHERE evidence = 'no_data')       AS no_data,
  count(*) FILTER (WHERE NOT is_scheduled_stop)      AS not_in_schedule,
  count(*) FILTER (WHERE stop_match = 'stop_id') AS matched_by_stop_id,
  median(lead_s) FILTER (WHERE evidence IN ('observed', 'near_estimate', 'prediction')) AS lead_p50_s,
  quantile_cont(lead_s, 0.05) FILTER (WHERE evidence IN ('observed', 'near_estimate', 'prediction')) AS lead_p05_s,
  quantile_cont(lead_s, 0.95) FILTER (WHERE evidence IN ('observed', 'near_estimate', 'prediction')) AS lead_p95_s
FROM fct_stop_event_tu
GROUP BY ALL;

-- qa_stop_event_tu_unmatched: one row per system, service date and route.
-- Feed stops on scheduled trips that match no scheduled stop of the trip.
-- These cluster on detoured routes, where the feed lists temporary stops.
CREATE OR REPLACE TABLE qa_stop_event_tu_unmatched AS
SELECT u.system_key, u.service_date, t.route_id,
       count(*) AS unmatched_feed_stops, count(DISTINCT u.trip_id) AS trips
FROM int_tu_stop u
JOIN fct_scheduled_trip t USING (system_key, service_date, trip_id)
LEFT JOIN fct_scheduled_stop_time s1
  ON s1.system_key = u.system_key AND s1.service_date = u.service_date AND s1.trip_id = u.trip_id
 AND s1.stop_sequence = u.stop_sequence AND (u.stop_id IS NULL OR u.stop_id = s1.stop_id)
LEFT JOIN (SELECT system_key, service_date, trip_id, stop_id FROM fct_scheduled_stop_time
           GROUP BY ALL HAVING count(*) = 1) s2
  ON s2.system_key = u.system_key AND s2.service_date = u.service_date AND s2.trip_id = u.trip_id
 AND s2.stop_id = u.stop_id
WHERE s1.stop_id IS NULL AND s2.stop_id IS NULL
GROUP BY ALL;
