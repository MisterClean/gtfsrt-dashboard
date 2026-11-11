-- Joins neither drop nor multiply the schedule: every scheduled trip and stop
-- time appears exactly once downstream.
WITH c AS (
  SELECT
    (SELECT count(*) FROM fct_scheduled_trip) AS sched_trips,
    (SELECT count(*) FROM fct_trip WHERE is_scheduled) AS trip_rows,
    (SELECT sum(scheduled_trips) FROM mart_trip_delivery) AS mart_trips,
    (SELECT count(*) FROM fct_scheduled_stop_time) AS sched_stop_times,
    (SELECT count(*) FROM fct_stop_event WHERE is_scheduled) AS event_rows
)
SELECT * FROM c
WHERE sched_trips <> trip_rows OR sched_trips <> mart_trips OR sched_stop_times <> event_rows;
