-- The offset lookups used to date realtime rows have one row per key, so the
-- joins in raw_trip_update_dated cannot fan out.
SELECT 'int_trip_offset' AS tbl, count(*) AS dup_keys
FROM (SELECT 1 FROM int_trip_offset GROUP BY system_key, trip_id HAVING count(*) > 1) HAVING count(*) > 0
UNION ALL
SELECT 'int_trip_stop_offset', count(*)
FROM (SELECT 1 FROM int_trip_stop_offset GROUP BY system_key, trip_id, stop_sequence HAVING count(*) > 1) HAVING count(*) > 0
UNION ALL
SELECT 'int_trip_stop_offset_by_stop', count(*)
FROM (SELECT 1 FROM int_trip_stop_offset_by_stop GROUP BY system_key, trip_id, stop_id HAVING count(*) > 1) HAVING count(*) > 0;
