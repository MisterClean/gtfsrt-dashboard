-- Prediction accuracy: how close the trip-updates feed's arrival predictions
-- were to what then happened.
--
-- Rules
--   * Sampling. Feeds are captured every 20 to 60 seconds and repeat each
--     prediction until it changes. To make feeds with different capture rates
--     comparable, one capture per whole minute is scored: the first capture
--     of the feed in that minute. Every prediction in that capture counts once.
--   * A prediction is the arrival time the feed gave for a stop (or the
--     scheduled arrival plus the given delay). Stops marked SKIPPED or
--     NO_DATA are not predictions.
--   * Truth is the stop's event in fct_stop_event, and its method is kept in
--     the grain. Where truth comes from trip updates it is the same feed's
--     final word, so near-term accuracy is flattered; read vehicle-position
--     truth where it exists.
--   * Horizon is truth minus capture time. Predictions with a horizon of zero
--     or less (made after the event) or over 30 minutes are not scored.
--   * Error is truth minus prediction, in seconds. Positive means the vehicle
--     came later than predicted; negative means it came earlier, which is the
--     costlier miss for a rider.
--   * Errors are stored as a histogram in 30-second bins, clamped at +/-30
--     minutes, so any accuracy window can be applied afterwards. The default
--     windows are in meta_prediction_window.

CREATE OR REPLACE TABLE meta_prediction_window (
  horizon_bucket VARCHAR PRIMARY KEY,
  horizon_min_s INTEGER,   -- exclusive
  horizon_max_s INTEGER,   -- inclusive
  early_limit_s INTEGER,   -- accurate when error_s >= this
  late_limit_s INTEGER     -- and error_s <= this
);
-- Windows widen with the horizon and allow less on the early side. They
-- follow the horizon bins and tolerances the MBTA publishes for its
-- prediction accuracy measure; treat them as a default, not a standard.
INSERT INTO meta_prediction_window VALUES
  ('00-03 min', 0, 180, -60, 60),
  ('03-06 min', 180, 360, -90, 120),
  ('06-12 min', 360, 720, -150, 210),
  ('12-30 min', 720, 1800, -240, 360);

-- fct_prediction_error: one row per system, service date, route, truth
-- method, horizon bucket and error bin. Additive.
CREATE OR REPLACE TABLE fct_prediction_error AS
WITH sample_poll AS (
  SELECT system_key, min(fetch_ts) AS fetch_ts
  FROM stg_poll
  WHERE feed_type = 'trip_updates'
  GROUP BY system_key, date_trunc('minute', fetch_ts)
),
scored AS (
  SELECT
    u.system_key, u.service_date, e.route_id, e.event_method AS truth_method,
    epoch(e.arrival_ts) - epoch(u.fetch_ts) AS horizon_s,
    epoch(e.arrival_ts) - coalesce(u.arrival_epoch,
                                   epoch(e.scheduled_arrival_ts) + u.arrival_delay,
                                   u.departure_epoch,
                                   epoch(e.scheduled_departure_ts) + u.departure_delay) AS error_s
  FROM raw_trip_update_dated u
  SEMI JOIN sample_poll p ON p.system_key = u.system_key AND p.fetch_ts = u.fetch_ts
  -- A prediction is scored against the stop it names, found the same way as
  -- in 41_stop_event_tu: the feed's stop_sequence when its stop_id (if given)
  -- is the scheduled stop there, else its stop_id when the trip serves that
  -- stop once. Rows that match neither are not scored.
  LEFT JOIN int_trip_stop_offset_by_stop bs
    ON bs.system_key = u.system_key AND bs.trip_id = u.trip_id AND bs.stop_id = u.stop_id
  JOIN fct_stop_event e
    ON e.system_key = u.system_key AND e.service_date = u.service_date AND e.trip_id = u.trip_id
   AND ((e.stop_sequence = u.stop_sequence AND (u.stop_id IS NULL OR u.stop_id = e.stop_id))
        OR (e.stop_sequence = bs.stop_sequence AND e.stop_id = u.stop_id
            AND e.stop_sequence IS DISTINCT FROM u.stop_sequence))
  WHERE u.stop_relationship = 0
    AND u.schedule_relationship <> 3
    AND e.event_method IS NOT NULL
    AND e.is_scheduled AND e.in_slice
)
SELECT
  s.system_key, s.service_date, s.route_id, s.truth_method,
  w.horizon_bucket,
  CAST(greatest(least(floor(s.error_s / 30) * 30, 1800), -1800) AS INTEGER) AS error_bin_s,
  count(*) AS predictions,
  count(*) FILTER (WHERE s.error_s BETWEEN w.early_limit_s AND w.late_limit_s) AS accurate,
  sum(s.error_s) AS sum_error_s,
  sum(abs(s.error_s)) AS sum_abs_error_s
FROM scored s
JOIN meta_prediction_window w
  ON s.horizon_s > w.horizon_min_s AND s.horizon_s <= w.horizon_max_s
WHERE s.error_s IS NOT NULL
GROUP BY ALL;
