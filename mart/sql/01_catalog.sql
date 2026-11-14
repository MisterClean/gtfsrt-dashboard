-- Catalog and plan: which feeds, which schedule version for each service day,
-- and which archive objects the build needs. The runner downloads plan_object.

CREATE OR REPLACE TABLE cat_feed AS
SELECT
  base64url                                        AS feed_key,
  feed_type,
  feed_id,
  agency_id || coalesce('-' || system_id, '')      AS system_key,
  agency_id,
  agency_name,
  system_id,
  system_name,
  url                                              AS feed_url,
  interval_seconds                                 AS poll_interval_s,
  coalesce(from_json(schedule_urls, '["VARCHAR"]'), [schedule_url]) AS schedule_urls
FROM read_parquet(getvariable('archive_dir') || '/feeds.parquet');

CREATE OR REPLACE TABLE cat_schedule_version AS
WITH src AS (
  SELECT schedule_url, base64url AS schedule_key, unnest(versions) AS v
  FROM read_json(getvariable('archive_dir') || '/schedules.json')
)
SELECT
  schedule_url,
  schedule_key,
  v._feed_digest                                   AS feed_digest,
  CAST(v.date_retrieved AS TIMESTAMPTZ)            AS retrieved_at,
  gtfs_date(v.feed_start_date)                     AS feed_start_date,
  gtfs_date(v.feed_end_date)                       AS feed_end_date
FROM src;

-- cat_schedule_extra: schedule sources a system needs beyond the ones its
-- feeds name, one row per system and source. This is data, not a rule: add a
-- row when qa_trip_id_match shows a system's realtime trip_ids living in
-- another archived schedule. agency_ids limits what the source contributes to
-- trips on routes of those GTFS agency_ids; NULL takes the whole schedule.
CREATE OR REPLACE TABLE cat_schedule_extra (
  system_key VARCHAR,
  schedule_url VARCHAR,
  agency_ids VARCHAR[],
  rationale VARCHAR,
  PRIMARY KEY (system_key, schedule_url)
);

INSERT INTO cat_schedule_extra VALUES
  ('sound-transit', 'https://metro.kingcounty.gov/GTFS/google_transit.zip', ['40'],
   'Sound Transit''s own schedule (40_gtfs.zip) has only Link, T Line, Sounder and Link shuttles. '
   || 'Its realtime feeds (regional OneBusAway, agency 40) also carry ST Express buses under the '
   || 'operators'' trip_ids. King County Metro''s schedule publishes the routes it operates for '
   || 'Sound Transit as agency_id 40, with the same trip_ids. ST Express trips run by Community '
   || 'Transit and Pierce Transit have no archived schedule and stay unmatched.');

-- One row per system: the systems asked for, with the schedule sources that
-- any of their feeds names, plus any in cat_schedule_extra.
CREATE OR REPLACE TABLE dim_system AS
SELECT
  f.system_key,
  any_value(f.agency_id)   AS agency_id,
  any_value(f.agency_name) AS agency_name,
  any_value(f.system_id)   AS system_id,
  any_value(f.system_name) AS system_name,
  list_distinct(flatten(list(f.schedule_urls))
    || coalesce((SELECT list(x.schedule_url ORDER BY x.schedule_url) FROM cat_schedule_extra x
                 WHERE x.system_key = f.system_key), [])) AS schedule_urls
FROM cat_feed f
WHERE list_contains(getvariable('systems'), f.system_key)
GROUP BY f.system_key;

CREATE OR REPLACE TABLE dim_feed AS
SELECT f.* EXCLUDE (schedule_urls)
FROM cat_feed f
WHERE list_contains(getvariable('systems'), f.system_key);

-- Schedule version in force for each system, schedule source and service day.
--   1. The most recently retrieved version that was retrieved on or before the
--      service day and whose advertised dates cover it. A missing feed date is
--      open-ended.
--   2. Failing that, the earliest later capture that covers the day, flagged.
--   3. Failing that, none: the day has no schedule and schedule-based metrics
--      are not produced for it.
-- source_role is 'feed' for a source the system's feeds name and 'extra' for
-- one from cat_schedule_extra; agency_ids (NULL = all) limits an extra source
-- to the routes of those agencies.
CREATE OR REPLACE TABLE plan_schedule AS
WITH want AS (
  SELECT s.system_key, unnest(s.schedule_urls) AS schedule_url, d.service_date
  FROM dim_system s, (SELECT unnest(getvariable('service_dates')) AS service_date) d
),
candidate AS (
  SELECT
    w.*,
    v.schedule_key,
    v.feed_digest,
    v.retrieved_at,
    CAST(v.retrieved_at AT TIME ZONE 'UTC' AS DATE) <= w.service_date AS retrieved_in_time
  FROM want w
  JOIN cat_schedule_version v
    ON v.schedule_url = w.schedule_url
   AND coalesce(v.feed_start_date, DATE '1900-01-01') <= w.service_date
   AND coalesce(v.feed_end_date, DATE '2999-12-31') >= w.service_date
)
SELECT
  w.system_key,
  w.service_date,
  w.schedule_url,
  c.schedule_key,
  c.feed_digest,
  c.retrieved_at,
  CASE WHEN c.feed_digest IS NULL THEN 'none'
       WHEN c.retrieved_in_time THEN 'in_force'
       ELSE 'captured_later' END AS schedule_basis,
  CASE WHEN x.system_key IS NULL THEN 'feed' ELSE 'extra' END AS source_role,
  x.agency_ids
FROM want w
LEFT JOIN (
  SELECT *
  FROM candidate
  QUALIFY row_number() OVER (
    PARTITION BY system_key, schedule_url, service_date
    ORDER BY retrieved_in_time DESC,
             CASE WHEN retrieved_in_time THEN retrieved_at END DESC,
             retrieved_at ASC) = 1
) c ON c.system_key = w.system_key AND c.schedule_url = w.schedule_url AND c.service_date = w.service_date
-- A source a feed names is never limited, even if it is also listed as extra.
LEFT JOIN cat_schedule_extra x
  ON x.system_key = w.system_key AND x.schedule_url = w.schedule_url
 AND NOT EXISTS (SELECT 1 FROM cat_feed f, unnest(f.schedule_urls) u(url)
                 WHERE f.system_key = w.system_key AND u.url = w.schedule_url);

-- Archive objects to download. Realtime objects are partitioned by UTC fetch
-- date. A service day in the Americas spans the UTC date and the next one;
-- the read window is re-checked against the agency time zone after staging
-- (test capture_window_covered).
CREATE OR REPLACE TABLE plan_object AS
WITH rt AS (
  SELECT DISTINCT
    f.feed_type AS kind,
    f.system_key,
    f.feed_type || '/date=' || strftime(d.service_date + o.day_offset, '%Y-%m-%d')
      || '/base64url=' || f.feed_key || '/data.parquet' AS object_path,
    false AS is_optional
  FROM dim_feed f,
       (SELECT unnest(getvariable('service_dates')) AS service_date) d,
       (SELECT unnest([0, 1]) AS day_offset) o
),
-- A schedule shared by two systems in the build (cat_schedule_extra) is listed
-- once, under the first system, so the runner never downloads it twice at once.
sched AS (
  SELECT
    'schedule:' || t.table_name AS kind,
    min(p.system_key) AS system_key,
    'schedules/base64url=' || p.schedule_key || '/_feed_digest=' || p.feed_digest
      || '/' || t.table_name || '.parquet' AS object_path,
    t.is_optional
  FROM plan_schedule p,
       (VALUES ('agency', false), ('routes', false), ('trips', false), ('stop_times', false),
               ('stops', false), ('calendar', true), ('calendar_dates', true), ('shapes', true),
               ('frequencies', true), ('feed_info', true)) t(table_name, is_optional)
  WHERE p.feed_digest IS NOT NULL
  GROUP BY ALL
)
SELECT * FROM rt
UNION ALL
SELECT * FROM sched;
