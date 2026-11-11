-- Feed capture and freshness. Every operational metric depends on the feed
-- having been captured, so these tables come first and later models use them
-- to decide what is eligible to be measured.

-- fct_feed_poll: one row per feed and capture that returned data.
--   freshness_s    capture time minus the feed header's own timestamp
--   since_prev_s   seconds since the previous capture of the same feed
--   is_stale       the feed header timestamp did not advance since the
--                  previous capture (the producer had not republished)
CREATE OR REPLACE TABLE fct_feed_poll AS
SELECT
  p.system_key,
  p.feed_key,
  p.feed_type,
  p.fetch_ts,
  p.feed_ts,
  p.n_rows,
  p.n_entities,
  epoch(p.fetch_ts) - epoch(p.feed_ts) AS freshness_s,
  epoch(p.fetch_ts) - epoch(lag(p.fetch_ts) OVER w) AS since_prev_s,
  p.feed_ts IS NOT DISTINCT FROM lag(p.feed_ts) OVER w AND p.feed_ts IS NOT NULL AS is_stale
FROM stg_poll p
WINDOW w AS (PARTITION BY p.feed_key ORDER BY p.fetch_ts);

-- fct_capture_gap: one row per feed and gap. A gap is a span longer than
-- capture_gap_s with no capture, inside the feed's read window, including the
-- spans before the first capture and after the last. A feed with no captures
-- at all has one gap covering its whole window. gap_kind separates a quiet or
-- failing feed from an archive outage by whether sibling feeds were captured.
CREATE OR REPLACE TABLE fct_capture_gap AS
WITH edges AS (
  SELECT w.system_key, w.feed_key, w.feed_type, w.read_start_ts AS ts FROM int_feed_window w
  UNION ALL
  SELECT w.system_key, w.feed_key, w.feed_type, w.read_end_ts FROM int_feed_window w
  UNION ALL
  SELECT system_key, feed_key, feed_type, fetch_ts FROM stg_poll
),
spans AS (
  SELECT system_key, feed_key, feed_type, ts AS gap_start_ts,
         lead(ts) OVER (PARTITION BY feed_key ORDER BY ts) AS gap_end_ts
  FROM edges
)
SELECT s.*, epoch(s.gap_end_ts) - epoch(s.gap_start_ts) AS gap_s,
  -- Captures of the system's other feeds during the gap. When they carried on,
  -- the archive was working and this feed was empty or failing at the source.
  -- When they stopped too, the archive itself was not capturing.
  (SELECT count(*) FROM stg_poll p
    WHERE p.system_key = s.system_key AND p.feed_key <> s.feed_key
      AND p.fetch_ts > s.gap_start_ts AND p.fetch_ts < s.gap_end_ts) AS sibling_polls,
  CASE WHEN (SELECT count(*) FROM stg_poll p
              WHERE p.system_key = s.system_key AND p.feed_key <> s.feed_key
                AND p.fetch_ts > s.gap_start_ts AND p.fetch_ts < s.gap_end_ts) > 0
       THEN 'feed_empty_or_failing' ELSE 'archive_not_capturing' END AS gap_kind
FROM spans s
WHERE s.gap_end_ts IS NOT NULL
  AND epoch(s.gap_end_ts) - epoch(s.gap_start_ts) > threshold('capture_gap_s');

-- int_service_span: the span on each service day inside which capture is
-- judged: from the first scheduled departure to the last scheduled arrival,
-- clipped to the slice. With no schedule it is the slice itself.
CREATE OR REPLACE TABLE int_service_span AS
SELECT
  d.system_key,
  d.service_date,
  greatest(coalesce(min(t.start_ts), d.slice_start_ts), d.slice_start_ts) AS span_start_ts,
  least(coalesce(max(t.end_ts), d.slice_end_ts), d.slice_end_ts)          AS span_end_ts
FROM dim_service_day d
LEFT JOIN fct_scheduled_trip t USING (system_key, service_date)
GROUP BY d.system_key, d.service_date, d.slice_start_ts, d.slice_end_ts;

-- mart_feed_day: one row per system, service date and feed type.
-- Additive columns only; shares are computed by the reader from the sums.
--   span_s            seconds in the service span
--   gap_s             seconds of that span inside capture gaps
--   polls             captures inside the span
--   polls_expected    span_s / the feed's configured polling interval
--   stale_polls       captures whose feed header had not advanced
--   freshness_*       distribution of capture time minus header time
CREATE OR REPLACE TABLE mart_feed_day AS
WITH f AS (
  SELECT s.system_key, s.service_date, w.feed_key, w.feed_type, w.poll_interval_s,
         s.span_start_ts, s.span_end_ts,
         epoch(s.span_end_ts) - epoch(s.span_start_ts) AS span_s
  FROM int_service_span s
  JOIN int_feed_window w USING (system_key)
),
gaps AS (
  SELECT f.system_key, f.service_date, f.feed_key,
         sum(epoch(least(g.gap_end_ts, f.span_end_ts)) - epoch(greatest(g.gap_start_ts, f.span_start_ts))) AS gap_s,
         count(*) AS gaps,
         max(epoch(least(g.gap_end_ts, f.span_end_ts)) - epoch(greatest(g.gap_start_ts, f.span_start_ts))) AS longest_gap_s
  FROM f
  JOIN fct_capture_gap g
    ON g.feed_key = f.feed_key AND g.gap_start_ts < f.span_end_ts AND g.gap_end_ts > f.span_start_ts
  GROUP BY ALL
),
polls AS (
  SELECT f.system_key, f.service_date, f.feed_key,
         count(*) AS polls,
         count(*) FILTER (WHERE p.is_stale) AS stale_polls,
         count(p.freshness_s) AS polls_with_header_time,
         median(p.freshness_s) AS freshness_p50_s,
         quantile_cont(p.freshness_s, 0.95) AS freshness_p95_s,
         median(p.since_prev_s) AS poll_interval_p50_s,
         sum(p.n_rows) AS archive_rows
  FROM f
  JOIN fct_feed_poll p
    ON p.feed_key = f.feed_key AND p.fetch_ts >= f.span_start_ts AND p.fetch_ts < f.span_end_ts
  GROUP BY ALL
)
SELECT
  f.system_key, f.service_date, f.feed_type, f.feed_key,
  f.span_start_ts, f.span_end_ts, f.span_s,
  coalesce(g.gap_s, 0) AS gap_s,
  coalesce(g.gaps, 0) AS gaps,
  coalesce(g.longest_gap_s, 0) AS longest_gap_s,
  coalesce(p.polls, 0) AS polls,
  CAST(round(f.span_s / f.poll_interval_s) AS BIGINT) AS polls_expected,
  f.poll_interval_s,
  p.poll_interval_p50_s,
  coalesce(p.stale_polls, 0) AS stale_polls,
  coalesce(p.polls_with_header_time, 0) AS polls_with_header_time,
  p.freshness_p50_s,
  p.freshness_p95_s,
  coalesce(p.archive_rows, 0) AS archive_rows
FROM f
LEFT JOIN gaps g USING (system_key, service_date, feed_key)
LEFT JOIN polls p USING (system_key, service_date, feed_key);
