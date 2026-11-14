-- Stop events sit near the schedule and inside the read window. A deviation
-- beyond four hours means a service-date or join error, not a late bus.
SELECT e.system_key, e.service_date, e.trip_id, e.stop_sequence, e.event_method, e.deviation_s
FROM fct_stop_event e
JOIN dim_service_day d USING (system_key, service_date)
WHERE e.event_method IS NOT NULL
  AND (abs(e.deviation_s) > 4 * 3600
       OR e.event_ts < d.read_start_ts - INTERVAL 1 HOUR
       OR e.event_ts > d.read_end_ts + INTERVAL 1 HOUR
       OR e.departure_ts < e.arrival_ts);
