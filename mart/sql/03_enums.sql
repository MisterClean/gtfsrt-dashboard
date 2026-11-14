-- GTFS-Realtime enum labels, so reports never show bare integers.
CREATE OR REPLACE TABLE meta_enum (enum_name VARCHAR, code INTEGER, label VARCHAR, PRIMARY KEY (enum_name, code));

INSERT INTO meta_enum VALUES
  ('trip_schedule_relationship', 0, 'SCHEDULED'), ('trip_schedule_relationship', 1, 'ADDED'),
  ('trip_schedule_relationship', 2, 'UNSCHEDULED'), ('trip_schedule_relationship', 3, 'CANCELED'),
  ('trip_schedule_relationship', 5, 'REPLACEMENT'), ('trip_schedule_relationship', 6, 'DUPLICATED'),
  ('trip_schedule_relationship', 7, 'DELETED'), ('trip_schedule_relationship', 8, 'NEW'),
  ('stop_schedule_relationship', 0, 'SCHEDULED'), ('stop_schedule_relationship', 1, 'SKIPPED'),
  ('stop_schedule_relationship', 2, 'NO_DATA'), ('stop_schedule_relationship', 3, 'UNSCHEDULED'),
  ('vehicle_stop_status', 0, 'INCOMING_AT'), ('vehicle_stop_status', 1, 'STOPPED_AT'),
  ('vehicle_stop_status', 2, 'IN_TRANSIT_TO'),
  ('alert_cause', 1, 'UNKNOWN_CAUSE'), ('alert_cause', 2, 'OTHER_CAUSE'), ('alert_cause', 3, 'TECHNICAL_PROBLEM'),
  ('alert_cause', 4, 'STRIKE'), ('alert_cause', 5, 'DEMONSTRATION'), ('alert_cause', 6, 'ACCIDENT'),
  ('alert_cause', 7, 'HOLIDAY'), ('alert_cause', 8, 'WEATHER'), ('alert_cause', 9, 'MAINTENANCE'),
  ('alert_cause', 10, 'CONSTRUCTION'), ('alert_cause', 11, 'POLICE_ACTIVITY'), ('alert_cause', 12, 'MEDICAL_EMERGENCY'),
  ('alert_effect', 1, 'NO_SERVICE'), ('alert_effect', 2, 'REDUCED_SERVICE'), ('alert_effect', 3, 'SIGNIFICANT_DELAYS'),
  ('alert_effect', 4, 'DETOUR'), ('alert_effect', 5, 'ADDITIONAL_SERVICE'), ('alert_effect', 6, 'MODIFIED_SERVICE'),
  ('alert_effect', 7, 'OTHER_EFFECT'), ('alert_effect', 8, 'UNKNOWN_EFFECT'), ('alert_effect', 9, 'STOP_MOVED'),
  ('alert_effect', 10, 'NO_EFFECT'), ('alert_effect', 11, 'ACCESSIBILITY_ISSUE');

CREATE OR REPLACE MACRO enum_label(n, c) AS
  coalesce((SELECT label FROM meta_enum WHERE enum_name = n AND code = c), 'CODE_' || CAST(c AS VARCHAR));
