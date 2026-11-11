-- mart_otp restates fct_stop_event: same eligible events, and early + on_time
-- + late account for every one of them.
WITH fact AS (
  SELECT e.system_key, e.service_date, count(*) AS n
  FROM fct_stop_event e
  JOIN fct_trip t USING (system_key, service_date, trip_id)
  WHERE e.is_scheduled AND e.in_slice AND e.deviation_s IS NOT NULL AND e.event_method IS NOT NULL
    AND NOT t.is_frequency_based AND NOT t.tu_canceled_at_last_sight
  GROUP BY ALL
),
mart AS (
  SELECT system_key, service_date, sum(timed_events) AS n, sum(early + on_time + late) AS parts
  FROM mart_otp GROUP BY ALL
)
SELECT * FROM fact FULL JOIN mart USING (system_key, service_date)
WHERE fact.n IS DISTINCT FROM mart.n OR mart.n <> mart.parts;
