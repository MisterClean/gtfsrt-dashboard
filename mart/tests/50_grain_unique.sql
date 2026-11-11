-- Every table's stated grain is unique.
SELECT 'fct_scheduled_trip' AS tbl, count(*) AS dup_keys FROM (SELECT 1 FROM fct_scheduled_trip GROUP BY system_key, service_date, trip_id HAVING count(*) > 1) HAVING count(*) > 0
UNION ALL SELECT 'fct_scheduled_stop_time', count(*) FROM (SELECT 1 FROM fct_scheduled_stop_time GROUP BY system_key, service_date, trip_id, stop_sequence HAVING count(*) > 1) HAVING count(*) > 0
UNION ALL SELECT 'stg_vehicle_position', count(*) FROM (SELECT 1 FROM stg_vehicle_position GROUP BY system_key, vehicle_id, trip_id, reported_start_date, position_ts HAVING count(*) > 1) HAVING count(*) > 0
UNION ALL SELECT 'int_tu_trip', count(*) FROM (SELECT 1 FROM int_tu_trip GROUP BY system_key, service_date, trip_id HAVING count(*) > 1) HAVING count(*) > 0
UNION ALL SELECT 'fct_stop_event_vp', count(*) FROM (SELECT 1 FROM fct_stop_event_vp GROUP BY system_key, service_date, trip_id, stop_sequence HAVING count(*) > 1) HAVING count(*) > 0
UNION ALL SELECT 'fct_stop_event_tu', count(*) FROM (SELECT 1 FROM fct_stop_event_tu GROUP BY system_key, service_date, trip_id, stop_sequence HAVING count(*) > 1) HAVING count(*) > 0
UNION ALL SELECT 'fct_stop_event', count(*) FROM (SELECT 1 FROM fct_stop_event GROUP BY system_key, service_date, trip_id, stop_sequence HAVING count(*) > 1) HAVING count(*) > 0
UNION ALL SELECT 'fct_trip', count(*) FROM (SELECT 1 FROM fct_trip GROUP BY system_key, service_date, trip_id HAVING count(*) > 1) HAVING count(*) > 0
UNION ALL SELECT 'fct_headway', count(*) FROM (SELECT 1 FROM fct_headway GROUP BY system_key, service_date, route_id, direction_id, stop_id, trip_id HAVING count(*) > 1) HAVING count(*) > 0
UNION ALL SELECT 'fct_feed_poll', count(*) FROM (SELECT 1 FROM fct_feed_poll GROUP BY feed_key, fetch_ts HAVING count(*) > 1) HAVING count(*) > 0
UNION ALL SELECT 'fct_alert', count(*) FROM (SELECT 1 FROM fct_alert GROUP BY system_key, alert_id, content_hash HAVING count(*) > 1) HAVING count(*) > 0
UNION ALL SELECT 'mart_feed_day', count(*) FROM (SELECT 1 FROM mart_feed_day GROUP BY system_key, service_date, feed_key HAVING count(*) > 1) HAVING count(*) > 0
UNION ALL SELECT 'rpt_route_day', count(*) FROM (SELECT 1 FROM rpt_route_day GROUP BY system_key, service_date, route_id HAVING count(*) > 1) HAVING count(*) > 0;
