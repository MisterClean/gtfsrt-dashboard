-- Shared macros and constants. Every threshold used by more than one model
-- lives in meta_threshold so the metric registry can cite it.

-- GTFS time 'H:MM:SS' or 'HH:MM:SS' (hours may pass 24) to seconds after the
-- service-day origin. Blank or malformed text gives NULL.
CREATE OR REPLACE MACRO gtfs_secs(t) AS
  CASE WHEN regexp_matches(trim(t), '^\d{1,3}:\d{2}:\d{2}$')
       THEN split_part(trim(t), ':', 1)::INTEGER * 3600
          + split_part(trim(t), ':', 2)::INTEGER * 60
          + split_part(trim(t), ':', 3)::INTEGER
  END;

-- GTFS defines the service-day origin as noon minus twelve hours, local time,
-- so that daylight-saving days line up. Returns TIMESTAMPTZ.
CREATE OR REPLACE MACRO service_origin(d, tz) AS
  timezone(tz, CAST(d AS TIMESTAMP) + INTERVAL 12 HOUR) - INTERVAL 12 HOUR;

CREATE OR REPLACE MACRO service_ts(d, secs, tz) AS
  service_origin(d, tz) + to_seconds(CAST(secs AS BIGINT));

-- Seconds from the service-day origin to an instant.
CREATE OR REPLACE MACRO service_secs(ts, d, tz) AS
  epoch(ts) - epoch(service_origin(d, tz));

-- 'YYYYMMDD' text to DATE; blank or malformed gives NULL.
CREATE OR REPLACE MACRO gtfs_date(s) AS
  CASE WHEN regexp_matches(trim(s), '^\d{8}$') THEN strptime(trim(s), '%Y%m%d')::DATE END;

CREATE OR REPLACE MACRO blank_null(s) AS nullif(trim(s), '');

-- Service date of a realtime row.
--   reported  the feed's start_date, believed when the row's event time is
--             within the tolerance of the schedule on that date (or when there
--             is no schedule to check it against)
--   sched     the date on which the scheduled time is nearest the event time;
--             used when start_date is absent, or fails the check (some feeds
--             give the calendar date on after-midnight trips)
--   clock     no start_date and no schedule: the local date three hours back
-- evt is the event instant, secs the scheduled offset of the same event.
CREATE OR REPLACE MACRO rt_service_date(reported, evt, secs, tz) AS
  CASE
    WHEN reported IS NOT NULL AND secs IS NULL THEN reported
    WHEN reported IS NOT NULL
     AND abs(epoch(evt) - epoch(service_ts(reported, secs, tz))) <= 14400 THEN reported
    WHEN secs IS NOT NULL
      THEN CAST(timezone(tz, evt) - to_seconds(CAST(secs AS BIGINT)) + INTERVAL 12 HOUR AS DATE)
    ELSE CAST(timezone(tz, evt) - INTERVAL 3 HOUR AS DATE)
  END;

CREATE OR REPLACE MACRO rt_service_date_basis(reported, evt, secs, tz) AS
  CASE
    WHEN reported IS NOT NULL AND secs IS NULL THEN 'reported_unchecked'
    WHEN reported IS NOT NULL
     AND abs(epoch(evt) - epoch(service_ts(reported, secs, tz))) <= 14400 THEN 'reported'
    WHEN secs IS NOT NULL THEN 'schedule_nearest'
    ELSE 'local_clock'
  END;

-- Great-circle distance in metres.
CREATE OR REPLACE MACRO haversine_m(lat1, lon1, lat2, lon2) AS
  2 * 6371008.8 * asin(sqrt(
      pow(sin(radians(lat2 - lat1) / 2), 2)
    + cos(radians(lat1)) * cos(radians(lat2)) * pow(sin(radians(lon2 - lon1) / 2), 2)));

CREATE OR REPLACE TABLE meta_threshold (
  threshold_key VARCHAR PRIMARY KEY,
  value DOUBLE,
  unit VARCHAR,
  rationale VARCHAR
);

INSERT INTO meta_threshold VALUES
  ('service_window_hours', 30, 'hours', 'Captures are read from the service-day origin to 30 hours after it, so after-midnight trips are whole.'),
  ('prediction_lead_hours', 1, 'hours', 'Captures are also read for one hour before the origin so predictions made ahead of the first trips are kept.'),
  ('service_date_tolerance_s', 14400, 'seconds', 'A reported start_date is believed when the observations fall within four hours of the trip''s scheduled window on that date.'),
  ('capture_gap_s', 300, 'seconds', 'A span this long with no successful capture of a feed is a capture gap.'),
  ('otp_early_s', -60, 'seconds', 'On time is at most one minute early. Exactly one minute early is on time.'),
  ('otp_late_s', 300, 'seconds', 'On time is less than five minutes late. Exactly five minutes late is late.'),
  ('tu_frozen_lead_s', 30, 'seconds', 'A trip-update stop time counts as observed when its final value was at most this far ahead of the last capture that carried it.'),
  ('tu_near_lead_s', 120, 'seconds', 'A final prediction up to this far ahead of its last capture is kept as a near-term estimate and labelled.'),
  ('frequent_headway_s', 900, 'seconds', 'Headway measures apply where the scheduled headway is 15 minutes or better.'),
  ('headway_bunched_ratio', 0.25, 'ratio', 'Observed headway under 25% of scheduled is bunched.'),
  ('headway_gap_ratio', 1.5, 'ratio', 'Observed headway over 150% of scheduled is a gap.'),
  ('min_events_shown', 20, 'events', 'Shares with fewer events are withheld.'),
  ('min_events_firm', 100, 'events', 'Shares with fewer events are marked low sample.');

CREATE OR REPLACE MACRO threshold(k) AS (SELECT value FROM meta_threshold WHERE threshold_key = k);
