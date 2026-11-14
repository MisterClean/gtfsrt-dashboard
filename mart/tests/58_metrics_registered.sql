-- Every rate column in the report views has a registry entry.
WITH cols AS (
  SELECT DISTINCT column_name,
    CASE WHEN column_name LIKE '%captured_share' THEN 'feed_captured_share'
         ELSE regexp_replace(column_name, '_s$', '') END AS metric_key
  FROM information_schema.columns
  WHERE table_name IN ('rpt_route_day', 'rpt_system_day')
    AND (column_name LIKE '%share' OR column_name LIKE '%share_at_least'
         OR column_name IN ('excess_wait_s', 'prediction_accuracy', 'mean_deviation_s'))
)
SELECT column_name, metric_key FROM cols
ANTI JOIN meta_metric USING (metric_key);
