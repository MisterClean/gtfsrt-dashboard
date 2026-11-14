-- Which planned archive objects are on disk, and helpers to list them.
-- Runs on every invocation, so later files can be re-run on their own.

-- An empty stub keeps read_parquet valid when a version has no optional table.
SET VARIABLE stub = getvariable('archive_dir') || '/_stub.parquet';
COPY (SELECT NULL::VARCHAR AS _stub WHERE false) TO (getvariable('stub')) (FORMAT parquet);

CREATE OR REPLACE TEMP TABLE present_object AS
SELECT p.kind, p.system_key, p.object_path, g.file AS local_path
FROM plan_object p
JOIN glob(getvariable('archive_dir') || '/**/*.parquet') g
  -- Matched by suffix: glob can return a differently-cased root on
  -- case-insensitive file systems.
  ON ends_with(g.file, '/archive/' || p.object_path);

CREATE OR REPLACE MACRO object_files(k) AS
  (SELECT list_distinct(list(local_path)) || [getvariable('stub')] FROM present_object WHERE kind = k);

SET VARIABLE f_vehicle_positions = object_files('vehicle_positions');
SET VARIABLE f_trip_updates      = object_files('trip_updates');
SET VARIABLE f_service_alerts    = object_files('service_alerts');
