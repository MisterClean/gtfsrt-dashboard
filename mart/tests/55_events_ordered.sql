-- Along a trip, events run forward in time. A small share out of order is
-- tolerated per system and method (trip-update times are rounded and revised);
-- over 2% means the method is broken for that feed.
WITH o AS (
  SELECT system_key, service_date, event_method,
    event_ts < lag(event_ts) OVER (PARTITION BY system_key, service_date, trip_id, event_method ORDER BY stop_sequence) AS backwards
  FROM fct_stop_event
  WHERE event_method IS NOT NULL AND is_scheduled
)
SELECT system_key, service_date, event_method, count(*) AS events, sum(backwards::INT) AS backwards
FROM o GROUP BY ALL
HAVING sum(backwards::INT) > 0.02 * count(*);
