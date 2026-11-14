-- int_tu_stop: one row per system, service date, trip_id and the stop as the
-- feed named it (stop_sequence and stop_id, either of which may be NULL).
SELECT system_key, service_date, trip_id, stop_sequence, stop_id, count(*) AS n
FROM int_tu_stop
GROUP BY system_key, service_date, trip_id, stop_sequence, stop_id
HAVING count(*) > 1;
