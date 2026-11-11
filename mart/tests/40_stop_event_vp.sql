-- Map-matched stop events (40_stop_event_vp.sql) keep their own rules:
-- stated grains are unique, progress and stop positions never go backward,
-- crossings within a run run forward in time, and no crossing is bracketed
-- by reports more than vp_max_event_gap_s (300 s) apart.
WITH grain AS (
  SELECT 'int_vp_line_segment grain' AS rule, count(*) AS n FROM (
    SELECT 1 FROM int_vp_line_segment GROUP BY feed_digest, line_id, seg_index HAVING count(*) > 1)
  UNION ALL SELECT 'int_vp_pattern_stop grain', count(*) FROM (
    SELECT 1 FROM int_vp_pattern_stop GROUP BY feed_digest, pattern_id, stop_index HAVING count(*) > 1)
  UNION ALL SELECT 'int_vp_run grain', count(*) FROM (
    SELECT 1 FROM int_vp_run GROUP BY run_id HAVING count(*) > 1)
  UNION ALL SELECT 'int_vp_trace_point grain', count(*) FROM (
    SELECT 1 FROM int_vp_trace_point GROUP BY run_id, step HAVING count(*) > 1)
  UNION ALL SELECT 'int_vp_stop_crossing grain', count(*) FROM (
    SELECT 1 FROM int_vp_stop_crossing GROUP BY run_id, stop_index HAVING count(*) > 1)
),
order_rules AS (
  SELECT 'stop positions decrease along a pattern' AS rule, count(*) AS n FROM (
    SELECT stop_s_m < lag(stop_s_m) OVER (PARTITION BY feed_digest, pattern_id ORDER BY stop_index) AS bad
    FROM int_vp_pattern_stop) WHERE bad
  UNION ALL SELECT 'progress decreases along a run', count(*) FROM (
    SELECT s_m < lag(s_m) OVER (PARTITION BY run_id ORDER BY step) OR t < lag(t) OVER (PARTITION BY run_id ORDER BY step) AS bad
    FROM int_vp_trace_point) WHERE bad
  UNION ALL SELECT 'crossings go back in time along a run', count(*) FROM (
    -- Stops under 2 m apart have zones that overlap (the zone never shrinks
    -- below 1 m), so the next arrival can precede this departure by a few
    -- seconds. Ten seconds or more is a real ordering error.
    SELECT coalesce(arrival_ts, departure_ts)
             < lag(coalesce(departure_ts, arrival_ts)) OVER (PARTITION BY run_id ORDER BY stop_index)
               - INTERVAL 10 SECOND AS bad
    FROM int_vp_stop_crossing WHERE arrival_ts IS NOT NULL OR departure_ts IS NOT NULL) WHERE bad
  UNION ALL SELECT 'arrival after departure', count(*) FROM fct_stop_event_vp WHERE arrival_ts > departure_ts
  UNION ALL SELECT 'crossing bracketed by a gap over 300 s', count(*) FROM fct_stop_event_vp
    WHERE arrival_bracket_gap_s > 300 OR departure_bracket_gap_s > 300
  UNION ALL SELECT 'event with neither crossing', count(*) FROM fct_stop_event_vp
    WHERE arrival_ts IS NULL AND departure_ts IS NULL
  UNION ALL SELECT 'event on a stop the trip does not have', count(*) FROM fct_stop_event_vp e
    ANTI JOIN fct_scheduled_stop_time s USING (system_key, service_date, trip_id, stop_sequence)
)
SELECT rule, n FROM grain WHERE n > 0
UNION ALL
SELECT rule, n FROM order_rules WHERE n > 0;
