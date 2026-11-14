-- A schedule source limited to some agencies (cat_schedule_extra) contributes
-- only trips and routes of those agencies.
SELECT 'fct_scheduled_trip' AS tbl, t.system_key, t.schedule_url, t.route_agency_id, count(*) AS n
FROM fct_scheduled_trip t
JOIN plan_schedule p USING (system_key, service_date, schedule_url)
WHERE p.agency_ids IS NOT NULL AND NOT coalesce(list_contains(p.agency_ids, t.route_agency_id), false)
GROUP BY ALL
UNION ALL
SELECT 'dim_route', r.system_key, p.schedule_url, r.route_id, count(*)
FROM dim_route r
JOIN plan_schedule p USING (system_key, feed_digest)
JOIN stg_routes s ON s.feed_digest = r.feed_digest AND s.route_id = r.route_id
WHERE p.agency_ids IS NOT NULL AND NOT coalesce(list_contains(p.agency_ids, s.agency_id), false)
GROUP BY ALL;
