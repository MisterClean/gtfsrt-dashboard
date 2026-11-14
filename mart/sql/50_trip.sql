-- Trip delivery: what happened to each trip.
--
-- fct_trip: one row per system, service date and trip_id, for every scheduled
-- trip in the build and every trip either realtime feed reported for a
-- service date in the build.
--
-- The archive cannot observe a trip that did not report. So the model keeps
-- the evidence in separate columns and derives one status from stated rules:
--
--   operated            stop events (either method) at half or more of the
--                       trip's scheduled stops.
--   canceled            a published cancellation still stood when the trip
--                       was due to finish, and the trip was not seen at half
--                       its stops. Two sources count, named in cancel_source:
--                         trip_updates  the feed's last word on the trip was
--                                       CANCELED
--                         alert         a NO_SERVICE alert naming the trip
--                                       was still carried at the trip's
--                                       scheduled end. One withdrawn before
--                                       then is a reinstated trip.
--                       A trip canceled after it set out counts here, with
--                       cancel_conflict recording that it was seen moving.
--   partly_observed     some evidence it ran (a stop event, or position
--                       reports on the trip), but under half its stops, and
--                       no cancellation.
--   not_observed        scheduled, no evidence in any feed, no cancellation.
--                       It may have run unreported or been dropped silently;
--                       the archive cannot tell which.
--   added               not in the schedule, seen running, and marked by the
--                       trip-updates feed as ADDED, NEW, REPLACEMENT or
--                       DUPLICATED.
--   unmatched           seen running under a trip_id the schedule does not
--                       have, with no such mark. Usually a schedule the build
--                       lacks (another operator's trips in a shared feed, or
--                       a newer schedule version), not extra service.
--
-- is_measurable says whether the feeds were being captured across the trip's
-- scheduled span: under 10% of the span inside capture gaps of every feed
-- the system has that can evidence a trip, and the trip wholly inside the
-- slice, and its route reported in realtime that day. Delivery rates count
-- measurable trips only, so an archive outage lowers the denominator instead
-- of reading as missed service.
--
-- is_route_reported: at least one scheduled trip of the route was observed
-- at half its stops that service day. Feeds often leave whole routes or modes
-- out (a subway line in a bus feed, a ferry, a contracted shuttle), or carry
-- a route only under trip_ids the schedule lacks. Those trips cannot be
-- observed and are counted apart, as unreported, not as missing. The cost: a
-- route suspended for a whole day lands here too.
CREATE OR REPLACE TABLE fct_trip AS
WITH vp AS (
  SELECT system_key, service_date, trip_id,
    count(*) AS vp_reports,
    min(position_ts) AS vp_first_ts,
    max(position_ts) AS vp_last_ts,
    count(DISTINCT vehicle_id) AS vp_vehicles,
    arg_max(route_id, position_ts) AS vp_route_id
  FROM stg_vehicle_position
  WHERE trip_id IS NOT NULL
  GROUP BY ALL
),
ev AS (
  SELECT system_key, service_date, trip_id,
    count(*) FILTER (WHERE event_method = 'vehicle_positions') AS vp_stop_events,
    count(*) FILTER (WHERE event_method = 'trip_updates')      AS tu_stop_events,
    count(*) FILTER (WHERE event_method IS NOT NULL AND is_scheduled) AS scheduled_stops_with_event,
    count(*) FILTER (WHERE event_method IS NOT NULL) AS stops_with_event,
    count(*) FILTER (WHERE tu_evidence = 'skipped')  AS stops_skipped
  FROM fct_stop_event
  GROUP BY ALL
),
-- NO_SERVICE alerts that name a trip. The alert's service date is the
-- informed trip's start_date when given, else a date carried in the alert id
-- (some feeds key cancellation alerts as <trip>_<YYYY-MM-DD>), else unknown,
-- in which case the alert applies to whichever service day it was live on.
trip_alert AS (
  SELECT system_key, informed_trip_id AS trip_id,
    coalesce(informed_trip_start_date,
             TRY_CAST(nullif(regexp_extract(alert_id, '(\d{4}-\d{2}-\d{2})', 1), '') AS DATE)) AS alert_service_date,
    min(first_seen_ts) AS first_seen_ts, max(last_seen_ts) AS last_seen_ts
  FROM stg_alert
  WHERE effect = 1 AND informed_trip_id IS NOT NULL
  GROUP BY ALL
),
alert AS (
  SELECT t.system_key, t.service_date, t.trip_id,
    min(a.first_seen_ts) AS alert_first_seen_ts,
    max(a.last_seen_ts)  AS alert_last_seen_ts,
    -- Still carried within ten minutes of the scheduled end (or the read
    -- window's end, if that comes first).
    max(a.last_seen_ts) >= least(t.end_ts, d.read_end_ts) - INTERVAL 10 MINUTE AS alert_stands
  FROM fct_scheduled_trip t
  JOIN dim_service_day d USING (system_key, service_date)
  JOIN trip_alert a
    ON a.system_key = t.system_key AND a.trip_id = t.trip_id
   AND (a.alert_service_date = t.service_date
        OR (a.alert_service_date IS NULL AND a.first_seen_ts <= t.end_ts
            AND a.last_seen_ts >= t.start_ts - INTERVAL 24 HOUR))
  GROUP BY t.system_key, t.service_date, t.trip_id, t.end_ts, d.read_end_ts
),
keys AS (
  SELECT system_key, service_date, trip_id FROM fct_scheduled_trip
  UNION
  SELECT system_key, service_date, trip_id FROM int_tu_trip
  UNION
  SELECT v.system_key, v.service_date, v.trip_id FROM vp v JOIN dim_service_day USING (system_key, service_date)
),
-- Seconds of each scheduled trip's span that fall inside capture gaps, per feed type.
gap AS (
  SELECT t.system_key, t.service_date, t.trip_id, g.feed_type,
    sum(epoch(least(g.gap_end_ts, t.end_ts)) - epoch(greatest(g.gap_start_ts, t.start_ts))) AS gap_s
  FROM fct_scheduled_trip t
  JOIN fct_capture_gap g
    ON g.system_key = t.system_key AND g.gap_start_ts < t.end_ts AND g.gap_end_ts > t.start_ts
  GROUP BY ALL
),
feeds AS (
  SELECT system_key,
    bool_or(feed_type = 'vehicle_positions') AS has_vp_feed,
    bool_or(feed_type = 'trip_updates')      AS has_tu_feed
  FROM dim_feed GROUP BY ALL
),
base AS (
  SELECT
    k.system_key, k.service_date, k.trip_id,
    s.trip_id IS NOT NULL AS is_scheduled,
    coalesce(s.route_id, u.route_id, vp.vp_route_id) AS route_id,
    coalesce(s.direction_id, u.direction_id) AS direction_id,
    s.feed_digest,
    s.start_ts AS scheduled_start_ts,
    s.end_ts   AS scheduled_end_ts,
    s.start_hour,
    s.n_stops  AS scheduled_stops,
    s.is_frequency_based,
    coalesce(s.in_slice, false) AS in_slice,
    -- vehicle positions
    coalesce(vp.vp_reports, 0) AS vp_reports,
    vp.vp_first_ts, vp.vp_last_ts,
    coalesce(vp.vp_vehicles, 0) AS vp_vehicles,
    -- trip updates
    u.trip_id IS NOT NULL AS in_trip_updates,
    u.first_seen_ts AS tu_first_seen_ts,
    u.last_seen_ts  AS tu_last_seen_ts,
    enum_label('trip_schedule_relationship', u.last_schedule_relationship) AS tu_last_relationship,
    coalesce(u.last_schedule_relationship = 3, false) AS tu_canceled_at_last_sight,
    u.first_canceled_ts IS NOT NULL AS tu_ever_canceled,
    u.first_canceled_ts AS tu_first_canceled_ts,
    -- Notice given: scheduled start minus the first capture that said CANCELED.
    -- Negative means the cancellation was published after the trip was due out.
    epoch(s.start_ts) - epoch(u.first_canceled_ts) AS cancel_notice_s,
    coalesce(list_has_any(u.schedule_relationships_seen, [1, 5, 6, 8]), false) AS tu_marked_added,
    -- alerts
    al.trip_id IS NOT NULL AS alert_ever_no_service,
    coalesce(al.alert_stands, false) AS alert_no_service_stands,
    al.alert_first_seen_ts,
    u.service_date_basis AS tu_service_date_basis,
    -- stop events
    coalesce(ev.vp_stop_events, 0) AS vp_stop_events,
    coalesce(ev.tu_stop_events, 0) AS tu_stop_events,
    coalesce(ev.scheduled_stops_with_event, 0) AS scheduled_stops_with_event,
    coalesce(ev.stops_with_event, 0) AS stops_with_event,
    coalesce(ev.stops_skipped, 0) AS stops_skipped,
    -- capture
    coalesce(gv.gap_s, 0) AS vp_gap_s,
    coalesce(gu.gap_s, 0) AS tu_gap_s,
    f.has_vp_feed, f.has_tu_feed
  FROM keys k
  JOIN feeds f USING (system_key)
  LEFT JOIN fct_scheduled_trip s USING (system_key, service_date, trip_id)
  LEFT JOIN int_tu_trip u USING (system_key, service_date, trip_id)
  LEFT JOIN vp USING (system_key, service_date, trip_id)
  LEFT JOIN alert al USING (system_key, service_date, trip_id)
  LEFT JOIN ev USING (system_key, service_date, trip_id)
  LEFT JOIN gap gv ON gv.system_key = k.system_key AND gv.service_date = k.service_date
                  AND gv.trip_id = k.trip_id AND gv.feed_type = 'vehicle_positions'
  LEFT JOIN gap gu ON gu.system_key = k.system_key AND gu.service_date = k.service_date
                  AND gu.trip_id = k.trip_id AND gu.feed_type = 'trip_updates'
),
routed AS (
  SELECT *,
    coalesce(bool_or(is_scheduled AND scheduled_stops_with_event >= 0.5 * scheduled_stops)
      OVER (PARTITION BY system_key, service_date, route_id), false) AS is_route_reported
  FROM base
),
judged AS (
  SELECT *,
    scheduled_stops_with_event / nullif(scheduled_stops, 0) AS observed_stop_share,
    is_scheduled AND in_slice AND is_route_reported
      AND (NOT has_vp_feed OR vp_gap_s < 0.1 * greatest(epoch(scheduled_end_ts) - epoch(scheduled_start_ts), 60))
      AND (NOT has_tu_feed OR tu_gap_s < 0.1 * greatest(epoch(scheduled_end_ts) - epoch(scheduled_start_ts), 60))
      AS is_measurable
  FROM routed
)
SELECT *,
  CASE
    WHEN is_scheduled AND observed_stop_share >= 0.5 THEN 'operated'
    WHEN tu_canceled_at_last_sight OR alert_no_service_stands THEN 'canceled'
    WHEN NOT is_scheduled AND (stops_with_event > 0 OR vp_reports > 0) AND tu_marked_added THEN 'added'
    WHEN NOT is_scheduled AND (stops_with_event > 0 OR vp_reports > 0) THEN 'unmatched'
    WHEN is_scheduled AND (stops_with_event > 0 OR vp_reports > 0) THEN 'partly_observed'
    WHEN is_scheduled THEN 'not_observed'
    ELSE 'reported_only'  -- named by trip updates, not scheduled, never seen moving
  END AS delivery_status,
  CASE WHEN tu_canceled_at_last_sight AND alert_no_service_stands THEN 'trip_updates+alert'
       WHEN tu_canceled_at_last_sight THEN 'trip_updates'
       WHEN alert_no_service_stands THEN 'alert' END AS cancel_source,
  -- A cancellation was published at some point, yet the trip was seen running.
  (tu_ever_canceled OR alert_ever_no_service) AND (stops_with_event > 0 OR vp_reports > 0) AS cancel_conflict
FROM judged;
