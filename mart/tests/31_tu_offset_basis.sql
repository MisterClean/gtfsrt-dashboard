-- Rules of raw_trip_update_dated, checked on their results:
--   a stop placed by stop_sequence has the feed's stop_id (when given) at that
--   sequence in the schedule;
--   a DUPLICATED run is its own trip, never merged into the trip it copies.
SELECT 'sequence_but_stop_disagrees' AS rule, s.system_key, s.trip_id, s.stop_sequence, s.stop_id
FROM int_tu_stop s
JOIN int_trip_stop_offset o USING (system_key, trip_id, stop_sequence)
WHERE s.schedule_offset_basis = 'stop_sequence' AND s.stop_id IS NOT NULL AND s.stop_id <> o.stop_id
UNION ALL
SELECT 'duplicate_not_split', system_key, trip_id, NULL, NULL
FROM int_tu_trip
WHERE duplicated_from_trip_id IS NOT NULL AND trip_id = duplicated_from_trip_id;
