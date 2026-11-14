-- Stop events, both methods side by side.
--
-- fct_stop_event: one row per system, service date, trip_id and stop_sequence
-- for every scheduled stop time in the build, plus stops that either method
-- reported on trips or stops the schedule does not have.
--
-- Method choice (recorded per row in event_method, never implied):
--   vehicle_positions  a map-matched crossing exists. Position-based
--                      measurement is used wherever positions support it.
--   trip_updates       no crossing, but the trip-updates feed's last time for
--                      the stop is graded 'observed' (see 41_stop_event_tu).
--   NULL               neither: the stop has no event. A missing event is not
--                      evidence that the stop was missed.
--
-- The timed event at a stop is its departure, and at a trip's last stop its
-- arrival, compared with the scheduled departure or arrival. Trip updates
-- that give only one of the two times use it for both.
CREATE OR REPLACE TABLE fct_stop_event AS
WITH keys AS (
  SELECT system_key, service_date, trip_id, stop_sequence FROM fct_scheduled_stop_time
  UNION
  SELECT system_key, service_date, trip_id, stop_sequence FROM fct_stop_event_vp
  UNION
  SELECT system_key, service_date, trip_id, stop_sequence FROM fct_stop_event_tu
),
wide AS (
  SELECT
    k.system_key, k.service_date, k.trip_id, k.stop_sequence,
    coalesce(s.stop_id, v.stop_id, u.stop_id) AS stop_id,
    s.trip_id IS NOT NULL AS is_scheduled,
    s.route_id, s.direction_id,
    s.arrival_ts   AS scheduled_arrival_ts,
    s.departure_ts AS scheduled_departure_ts,
    s.is_timepoint, s.is_first_stop, s.is_last_stop, s.is_time_interpolated, s.in_slice,
    v.arrival_ts   AS vp_arrival_ts,
    v.departure_ts AS vp_departure_ts,
    v.bracket_gap_s AS vp_bracket_gap_s,
    v.vehicle_id   AS vp_vehicle_id,
    u.arrival_ts   AS tu_arrival_ts,
    u.departure_ts AS tu_departure_ts,
    u.evidence     AS tu_evidence,
    u.lead_s       AS tu_lead_s,
    u.vehicle_id   AS tu_vehicle_id
  FROM keys k
  LEFT JOIN fct_scheduled_stop_time s USING (system_key, service_date, trip_id, stop_sequence)
  -- A crossing whose bracketing step moved much further along the line than
  -- the GPS did (is_bracket_jump) is a match that leapt ahead, not an
  -- observation, and is not used. They are counted in qa_vp_match.
  LEFT JOIN (SELECT * FROM fct_stop_event_vp WHERE NOT coalesce(is_bracket_jump, false)) v
    USING (system_key, service_date, trip_id, stop_sequence)
  LEFT JOIN fct_stop_event_tu u USING (system_key, service_date, trip_id, stop_sequence)
),
chosen AS (
  SELECT *,
    CASE WHEN vp_arrival_ts IS NOT NULL OR vp_departure_ts IS NOT NULL THEN 'vehicle_positions'
         WHEN tu_evidence = 'observed' THEN 'trip_updates' END AS event_method
  FROM wide
),
timed AS (
  SELECT *,
    CASE event_method WHEN 'vehicle_positions' THEN coalesce(vp_arrival_ts, vp_departure_ts)
                      WHEN 'trip_updates' THEN tu_arrival_ts END AS arrival_ts,
    CASE event_method WHEN 'vehicle_positions' THEN coalesce(vp_departure_ts, vp_arrival_ts)
                      WHEN 'trip_updates' THEN tu_departure_ts END AS departure_ts,
    CASE event_method WHEN 'vehicle_positions' THEN vp_vehicle_id
                      WHEN 'trip_updates' THEN tu_vehicle_id END AS vehicle_id
  FROM chosen
)
SELECT
  *,
  CASE WHEN is_last_stop THEN arrival_ts ELSE departure_ts END AS event_ts,
  CASE WHEN is_last_stop THEN scheduled_arrival_ts ELSE scheduled_departure_ts END AS scheduled_event_ts,
  epoch(CASE WHEN is_last_stop THEN arrival_ts ELSE departure_ts END)
    - epoch(CASE WHEN is_last_stop THEN scheduled_arrival_ts ELSE scheduled_departure_ts END) AS deviation_s,
  -- Trip updates minus vehicle positions, where both methods have the stop.
  CASE WHEN tu_evidence IN ('observed', 'near_estimate') THEN epoch(tu_arrival_ts) - epoch(vp_arrival_ts) END AS method_diff_s
FROM timed;

-- qa_stop_event_method: one row per system, service date and trip-update
-- evidence grade. How far the trip-updates feed's last time for a stop sits
-- from the map-matched arrival. This is the standing check on both methods:
-- a wide spread means one of them is wrong for that feed.
CREATE OR REPLACE TABLE qa_stop_event_method AS
SELECT
  system_key, service_date, tu_evidence,
  count(*) AS stops_with_both,
  median(method_diff_s) AS diff_p50_s,
  quantile_cont(method_diff_s, 0.05) AS diff_p05_s,
  quantile_cont(method_diff_s, 0.95) AS diff_p95_s,
  count(*) FILTER (WHERE abs(method_diff_s) <= 30)  AS within_30s,
  count(*) FILTER (WHERE abs(method_diff_s) <= 60)  AS within_60s,
  count(*) FILTER (WHERE abs(method_diff_s) <= 120) AS within_120s
FROM fct_stop_event
WHERE method_diff_s IS NOT NULL
GROUP BY ALL;

-- qa_stop_event_coverage: one row per system, service date and stop position
-- (first, middle, last). Of scheduled stop times, how many have an event by
-- each method. Feeds often treat a trip's ends differently from its middle:
-- a trip-updates feed may never list the last stop, and a first-stop time may
-- leave the feed before departure.
CREATE OR REPLACE TABLE qa_stop_event_coverage AS
SELECT
  system_key, service_date,
  CASE WHEN is_first_stop THEN 'first' WHEN is_last_stop THEN 'last' ELSE 'middle' END AS stop_position,
  count(*) AS scheduled_stop_times,
  count(*) FILTER (WHERE vp_arrival_ts IS NOT NULL OR vp_departure_ts IS NOT NULL) AS with_vp_event,
  count(*) FILTER (WHERE tu_evidence = 'observed') AS with_tu_observed,
  count(*) FILTER (WHERE tu_evidence IS NULL) AS absent_from_trip_updates,
  count(*) FILTER (WHERE event_method = 'vehicle_positions') AS chosen_vp,
  count(*) FILTER (WHERE event_method = 'trip_updates') AS chosen_tu,
  count(*) FILTER (WHERE event_method IS NULL) AS no_event
FROM fct_stop_event
WHERE is_scheduled AND in_slice
GROUP BY ALL;
