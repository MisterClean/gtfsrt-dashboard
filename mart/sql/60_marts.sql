-- Marts: additive sums at reporting grain, and report views that turn them
-- into rates.
--
-- Two rules hold everywhere:
--   1. Marts store counts and sums, never rates. A rate is always computed
--      from merged sums, so averaging averages cannot happen.
--   2. Every rate in a report view is printed with its n and is NULL when n
--      is under min_events_shown; *_sample says 'low' under min_events_firm.

CREATE OR REPLACE MACRO rate(num, den) AS
  CASE WHEN den >= threshold('min_events_shown') THEN num / den END;

CREATE OR REPLACE MACRO sample_grade(den) AS
  CASE WHEN den < threshold('min_events_shown') THEN 'withheld'
       WHEN den < threshold('min_events_firm') THEN 'low'
       ELSE 'ok' END;

-- ---------------------------------------------------------------------------
-- mart_otp: one row per system, service date, route, direction, service hour,
-- event method and timepoint flag.
--
-- Eligible events: a scheduled stop time, inside the slice, on a trip that is
-- not frequency-based and whose last word in trip updates was not CANCELED,
-- with a stop event. deviation = observed - scheduled, at the departure (the
-- arrival at a trip's last stop).
--   early    deviation <  otp_early_s
--   on_time  otp_early_s <= deviation < otp_late_s
--   late     deviation >= otp_late_s
-- The service hour is that of the scheduled time, 0 to 29.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE TABLE mart_otp AS
SELECT
  e.system_key, e.service_date, e.route_id, e.direction_id,
  CAST(floor((epoch(e.scheduled_event_ts) - epoch(d.origin_ts)) / 3600) AS INTEGER) AS service_hour,
  e.event_method,
  e.is_timepoint,
  count(*) AS timed_events,
  count(*) FILTER (WHERE e.deviation_s < threshold('otp_early_s')) AS early,
  count(*) FILTER (WHERE e.deviation_s >= threshold('otp_early_s')
                     AND e.deviation_s < threshold('otp_late_s')) AS on_time,
  count(*) FILTER (WHERE e.deviation_s >= threshold('otp_late_s')) AS late,
  sum(e.deviation_s) AS sum_deviation_s,
  sum(abs(e.deviation_s)) AS sum_abs_deviation_s
FROM fct_stop_event e
JOIN dim_service_day d USING (system_key, service_date)
JOIN fct_trip t USING (system_key, service_date, trip_id)
WHERE e.is_scheduled AND e.in_slice
  AND e.event_method IS NOT NULL
  AND e.deviation_s IS NOT NULL
  AND NOT t.is_frequency_based
  AND NOT t.tu_canceled_at_last_sight
GROUP BY ALL;

-- ---------------------------------------------------------------------------
-- mart_trip_delivery: one row per system, service date, route, direction and
-- scheduled start hour (NULL hour for trips not in the schedule).
--   scheduled_trips    trips the schedule ran that day
--   measurable_trips   of those, trips whose span the feeds were captured for,
--                      on routes that reported in realtime that day
--   unreported_route_trips  scheduled trips on routes no vehicle reported on
--   operated / partly_observed / canceled / not_observed
--                      measurable trips by delivery_status (see 50_trip.sql)
--   added_trips        trips seen running that the feed marked as added
--   unmatched_trips    trips seen running whose trip_id the schedule lacks
--   canceled_with_notice  canceled trips whose cancellation was first
--                      published before the scheduled start
-- ---------------------------------------------------------------------------
CREATE OR REPLACE TABLE mart_trip_delivery AS
SELECT
  system_key, service_date, route_id, direction_id, start_hour,
  count(*) FILTER (WHERE is_scheduled) AS scheduled_trips,
  count(*) FILTER (WHERE is_measurable) AS measurable_trips,
  count(*) FILTER (WHERE is_scheduled AND NOT is_route_reported) AS unreported_route_trips,
  count(*) FILTER (WHERE is_measurable AND delivery_status = 'operated') AS operated,
  count(*) FILTER (WHERE is_measurable AND delivery_status = 'partly_observed') AS partly_observed,
  count(*) FILTER (WHERE is_measurable AND delivery_status = 'canceled') AS canceled,
  count(*) FILTER (WHERE is_measurable AND delivery_status = 'not_observed') AS not_observed,
  count(*) FILTER (WHERE is_measurable AND delivery_status = 'canceled' AND cancel_notice_s > 0) AS canceled_with_notice,
  count(*) FILTER (WHERE delivery_status = 'added') AS added_trips,
  count(*) FILTER (WHERE delivery_status = 'unmatched') AS unmatched_trips,
  count(*) FILTER (WHERE cancel_conflict) AS cancel_conflicts
FROM fct_trip
GROUP BY ALL;

-- ---------------------------------------------------------------------------
-- mart_headway: one row per system, service date, route, direction, service
-- hour and event method, for frequent service only.
--   headways           valid observed headways (see 51_headway.sql)
--   bunched            observed < headway_bunched_ratio x scheduled
--   gaps               observed > headway_gap_ratio x scheduled
--   within_3min        observed <= scheduled + 180 s (wait assessment)
--   sum_h, sum_h2      for average wait = sum_h2 / (2 x sum_h), the expected
--                      wait of a rider arriving at random
--   sum_sh, sum_sh2    the same sums over the scheduled headways of the same
--                      events, for scheduled wait and so excess wait
-- The hour is that of the observed event.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE TABLE mart_headway AS
SELECT
  h.system_key, h.service_date, h.route_id, h.direction_id,
  CAST(floor((epoch(h.event_ts) - epoch(d.origin_ts)) / 3600) AS INTEGER) AS service_hour,
  h.event_method,
  count(*) AS headways,
  count(*) FILTER (WHERE h.observed_headway_s < threshold('headway_bunched_ratio') * h.scheduled_headway_s) AS bunched,
  count(*) FILTER (WHERE h.observed_headway_s > threshold('headway_gap_ratio') * h.scheduled_headway_s) AS gaps,
  count(*) FILTER (WHERE h.observed_headway_s <= h.scheduled_headway_s + 180) AS within_3min,
  sum(h.observed_headway_s) AS sum_h,
  sum(h.observed_headway_s * h.observed_headway_s) AS sum_h2,
  sum(h.scheduled_headway_s) AS sum_sh,
  sum(h.scheduled_headway_s * h.scheduled_headway_s) AS sum_sh2
FROM fct_headway h
JOIN dim_service_day d USING (system_key, service_date)
WHERE h.is_valid AND h.is_frequent AND h.in_slice
GROUP BY ALL;

-- ---------------------------------------------------------------------------
-- mart_prediction: one row per system, service date, route, truth method and
-- horizon bucket. See 52_prediction.sql.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE TABLE mart_prediction AS
SELECT system_key, service_date, route_id, truth_method, horizon_bucket,
  sum(predictions) AS predictions,
  sum(accurate) AS accurate,
  sum(sum_error_s) AS sum_error_s,
  sum(sum_abs_error_s) AS sum_abs_error_s
FROM fct_prediction_error
GROUP BY ALL;

-- ---------------------------------------------------------------------------
-- Report views. Rates from sums, each beside its n.
-- ---------------------------------------------------------------------------

-- rpt_route_day: one row per system, service date and route.
-- On-time performance is at timepoints, all hours, on stop events from
-- vehicle positions only. Stops that only trip updates could time are a
-- different population (mostly trip ends, by a different method) and are
-- reported beside it as tu_on_time_share, never pooled in.
CREATE OR REPLACE VIEW rpt_route_day AS
WITH otp AS (
  SELECT system_key, service_date, route_id,
    sum(timed_events) AS otp_n, sum(on_time) AS on_time, sum(early) AS early, sum(late) AS late,
    sum(sum_deviation_s) AS sum_deviation_s
  FROM mart_otp WHERE is_timepoint AND event_method = 'vehicle_positions' GROUP BY ALL
),
otp_tu AS (
  SELECT system_key, service_date, route_id, sum(timed_events) AS tu_otp_n, sum(on_time) AS tu_on_time
  FROM mart_otp WHERE is_timepoint AND event_method = 'trip_updates' GROUP BY ALL
),
del AS (
  SELECT system_key, service_date, route_id,
    sum(scheduled_trips) AS scheduled_trips, sum(measurable_trips) AS measurable_trips,
    sum(unreported_route_trips) AS unreported_route_trips,
    sum(operated) AS operated, sum(partly_observed) AS partly_observed,
    sum(canceled) AS canceled, sum(not_observed) AS not_observed, sum(added_trips) AS added_trips,
    sum(unmatched_trips) AS unmatched_trips
  FROM mart_trip_delivery GROUP BY ALL
),
hw AS (
  SELECT system_key, service_date, route_id,
    sum(headways) AS headways, sum(bunched) AS bunched, sum(gaps) AS gaps, sum(within_3min) AS within_3min,
    sum(sum_h) AS sum_h, sum(sum_h2) AS sum_h2, sum(sum_sh) AS sum_sh, sum(sum_sh2) AS sum_sh2
  FROM mart_headway GROUP BY ALL
),
pred AS (
  SELECT system_key, service_date, route_id, sum(predictions) AS predictions, sum(accurate) AS accurate
  FROM mart_prediction GROUP BY ALL
),
alert AS (
  SELECT system_key, service_date, route_id, sum(alert_s) AS alert_s,
         string_agg(DISTINCT effect, ', ' ORDER BY effect) AS alert_effects
  FROM fct_alert_route_day GROUP BY ALL
)
SELECT
  del.system_key, del.service_date, del.route_id,
  -- delivery
  del.scheduled_trips, del.measurable_trips, del.unreported_route_trips,
  del.operated, del.partly_observed, del.canceled, del.not_observed,
  del.added_trips, del.unmatched_trips,
  rate(del.operated, del.measurable_trips)     AS operated_share,
  rate(del.canceled, del.measurable_trips)     AS canceled_share,
  rate(del.not_observed, del.measurable_trips) AS not_observed_share,
  sample_grade(del.measurable_trips)           AS delivery_sample,
  -- on-time performance at timepoints
  otp.otp_n,
  rate(otp.on_time, otp.otp_n) AS on_time_share,
  rate(otp.early, otp.otp_n)   AS early_share,
  rate(otp.late, otp.otp_n)    AS late_share,
  rate(otp.sum_deviation_s, otp.otp_n) AS mean_deviation_s,
  sample_grade(coalesce(otp.otp_n, 0)) AS otp_sample,
  -- the same measure on stops only trip updates could time, kept apart
  otp_tu.tu_otp_n,
  rate(otp_tu.tu_on_time, otp_tu.tu_otp_n) AS tu_on_time_share,
  -- frequent-service headways
  hw.headways,
  rate(hw.bunched, hw.headways)     AS bunched_share,
  rate(hw.gaps, hw.headways)        AS gap_share_at_least,
  rate(hw.within_3min, hw.headways) AS wait_assessment_share,
  CASE WHEN hw.headways >= threshold('min_events_shown')
       THEN hw.sum_h2 / (2 * hw.sum_h) - hw.sum_sh2 / (2 * hw.sum_sh) END AS excess_wait_s,
  sample_grade(coalesce(hw.headways, 0)) AS headway_sample,
  -- predictions
  pred.predictions,
  rate(pred.accurate, pred.predictions) AS prediction_accuracy,
  -- alerts
  coalesce(alert.alert_s, 0) AS alert_s,
  alert.alert_effects
FROM del
LEFT JOIN otp USING (system_key, service_date, route_id)
LEFT JOIN otp_tu USING (system_key, service_date, route_id)
LEFT JOIN hw USING (system_key, service_date, route_id)
LEFT JOIN pred USING (system_key, service_date, route_id)
LEFT JOIN alert USING (system_key, service_date, route_id);

-- rpt_system_day: one row per system and service date, with the feed-quality
-- context a reader needs before trusting the rest.
CREATE OR REPLACE VIEW rpt_system_day AS
WITH otp AS (
  SELECT system_key, service_date,
    sum(timed_events) AS otp_n, sum(on_time) AS on_time
  FROM mart_otp WHERE is_timepoint AND event_method = 'vehicle_positions' GROUP BY ALL
),
otp_tu AS (
  SELECT system_key, service_date, sum(timed_events) AS tu_otp_n, sum(on_time) AS tu_on_time
  FROM mart_otp WHERE is_timepoint AND event_method = 'trip_updates' GROUP BY ALL
),
del AS (
  SELECT system_key, service_date,
    sum(scheduled_trips) AS scheduled_trips, sum(measurable_trips) AS measurable_trips,
    sum(unreported_route_trips) AS unreported_route_trips,
    sum(operated) AS operated, sum(partly_observed) AS partly_observed,
    sum(canceled) AS canceled, sum(not_observed) AS not_observed, sum(added_trips) AS added_trips,
    sum(unmatched_trips) AS unmatched_trips
  FROM mart_trip_delivery GROUP BY ALL
),
hw AS (
  SELECT system_key, service_date,
    sum(headways) AS headways, sum(bunched) AS bunched, sum(gaps) AS gaps,
    sum(sum_h) AS sum_h, sum(sum_h2) AS sum_h2, sum(sum_sh) AS sum_sh, sum(sum_sh2) AS sum_sh2
  FROM mart_headway GROUP BY ALL
),
pred AS (
  SELECT system_key, service_date, sum(predictions) AS predictions, sum(accurate) AS accurate
  FROM mart_prediction GROUP BY ALL
),
feed AS (
  SELECT system_key, service_date,
    max(1 - gap_s / nullif(span_s, 0)) FILTER (WHERE feed_type = 'vehicle_positions') AS vp_captured_share,
    max(1 - gap_s / nullif(span_s, 0)) FILTER (WHERE feed_type = 'trip_updates')      AS tu_captured_share,
    max(freshness_p50_s) FILTER (WHERE feed_type = 'vehicle_positions') AS vp_freshness_p50_s,
    max(freshness_p50_s) FILTER (WHERE feed_type = 'trip_updates')      AS tu_freshness_p50_s
  FROM mart_feed_day GROUP BY ALL
)
SELECT
  d.system_key, d.service_date, d.timezone, d.schedule_basis, d.is_slice,
  feed.vp_captured_share, feed.tu_captured_share, feed.vp_freshness_p50_s, feed.tu_freshness_p50_s,
  del.scheduled_trips, del.measurable_trips, del.unreported_route_trips,
  del.operated, del.partly_observed, del.canceled,
  del.not_observed, del.added_trips, del.unmatched_trips,
  rate(del.operated, del.measurable_trips)     AS operated_share,
  rate(del.canceled, del.measurable_trips)     AS canceled_share,
  rate(del.not_observed, del.measurable_trips) AS not_observed_share,
  otp.otp_n,
  rate(otp.on_time, otp.otp_n) AS on_time_share,
  otp_tu.tu_otp_n,
  rate(otp_tu.tu_on_time, otp_tu.tu_otp_n) AS tu_on_time_share,
  hw.headways,
  rate(hw.bunched, hw.headways) AS bunched_share,
  rate(hw.gaps, hw.headways)    AS gap_share_at_least,
  CASE WHEN hw.headways >= threshold('min_events_shown')
       THEN hw.sum_h2 / (2 * hw.sum_h) - hw.sum_sh2 / (2 * hw.sum_sh) END AS excess_wait_s,
  pred.predictions,
  rate(pred.accurate, pred.predictions) AS prediction_accuracy
FROM dim_service_day d
LEFT JOIN feed USING (system_key, service_date)
LEFT JOIN del USING (system_key, service_date)
LEFT JOIN otp USING (system_key, service_date)
LEFT JOIN otp_tu USING (system_key, service_date)
LEFT JOIN hw USING (system_key, service_date)
LEFT JOIN pred USING (system_key, service_date);
