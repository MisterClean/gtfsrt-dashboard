-- The archive objects that were read cover each service day's read window:
-- some feed of the system was captured within ten minutes of both ends.
-- Fails when the object for the following UTC day is missing, or when the
-- agency's time zone puts the window outside the two UTC dates fetched.
SELECT d.system_key, d.service_date, d.read_start_ts, d.read_end_ts,
       min(p.fetch_ts) AS first_capture, max(p.fetch_ts) AS last_capture
FROM dim_service_day d
LEFT JOIN stg_poll p
  ON p.system_key = d.system_key AND p.fetch_ts >= d.read_start_ts AND p.fetch_ts < d.read_end_ts
GROUP BY ALL
HAVING min(p.fetch_ts) IS NULL
    OR min(p.fetch_ts) > d.read_start_ts + INTERVAL 10 MINUTE
    OR max(p.fetch_ts) < d.read_end_ts - INTERVAL 10 MINUTE;
