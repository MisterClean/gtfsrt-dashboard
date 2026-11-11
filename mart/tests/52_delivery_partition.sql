-- Measurable trips split exactly into the four delivery statuses.
SELECT system_key, service_date, route_id, direction_id, start_hour
FROM mart_trip_delivery
WHERE measurable_trips <> operated + partly_observed + canceled + not_observed
   OR measurable_trips > scheduled_trips;
