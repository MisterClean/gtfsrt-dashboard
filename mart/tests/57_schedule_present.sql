-- Every service day has a schedule, a time zone and at least one trip.
SELECT d.system_key, d.service_date, d.schedule_basis, d.timezone,
       (SELECT count(*) FROM fct_scheduled_trip t WHERE t.system_key = d.system_key AND t.service_date = d.service_date) AS trips
FROM dim_service_day d
WHERE d.schedule_basis = 'none' OR d.timezone IS NULL
   OR NOT EXISTS (SELECT 1 FROM fct_scheduled_trip t WHERE t.system_key = d.system_key AND t.service_date = d.service_date);
