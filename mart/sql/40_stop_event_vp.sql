-- Observed stop events from vehicle positions.
--
-- Each vehicle's reports for a trip are map-matched to the trip's line, which
-- turns them into a time series of progress along it (metres from the start).
-- A stop event is the moment that progress crosses a point just before the
-- stop (arrival) and just after it (departure), interpolated between the two
-- reports either side.
--
-- The method follows the app's Rust engine (docs/metrics.md, "Placing vehicles
-- on the route" and "Stop passes"; crates/core/src/geo.rs, trace.rs, day.rs).
-- Where SQL cannot reasonably copy it, the departure is stated at the spot.
-- Distances use a flat projection centred on each line, as the engine does:
--   x = (lon - lon0) * cos(lat0) * 111,320 m     y = (lat - lat0) * 111,320 m
--
-- Pipeline
--   1. int_vp_line, int_vp_line_segment   each trip's line, in metres
--   2. int_vp_pass                        where each stop and report sits on its line
--   3. int_vp_pattern_stop                stops placed along the line in order
--   4. int_vp_run, int_vp_trace_point     reports followed along the line, forward only
--   5. int_vp_stop_crossing               crossing times per run and stop
--   6. fct_stop_event_vp                  one event per trip and stop
--   7. qa_vp_*                            match quality and coverage

-- ---------------------------------------------------------------------------
-- Thresholds. Tags in brackets are the Rust constant each one copies.
-- ---------------------------------------------------------------------------

-- A report or stop farther than this from the line is not on it. [TraceRules.max_offset_m]
SET VARIABLE vp_max_offset_m = 120.0;
-- Two closest approaches of the line to one point that are further apart than
-- this along the line are separate passes (a loop or out-and-back). [geo.rs candidates: 2 x max offset]
SET VARIABLE vp_pass_split_m = 240.0;
-- A report may land this far behind the last position; it is then held there,
-- because GPS jitter at a stop must not move a vehicle backward. [trace.rs follow_from]
SET VARIABLE vp_back_window_m = 60.0;
-- Reports landing more than this behind are counted as backward moves. [trace.rs follow_from]
SET VARIABLE vp_backward_count_m = 30.0;
-- Furthest a vehicle can have gone since its last position:
-- max speed x elapsed + this slack. [trace.rs follow_from]
SET VARIABLE vp_reach_slack_m = 200.0;
-- Max speeds for that reach: 80 mph on the street, 150 mph for rail and ferry. [T6]
SET VARIABLE vp_street_max_mps = 35.8;
SET VARIABLE vp_rail_max_mps = 67.0;
-- An earlier pass whose fit is at most this much worse than the best fit is
-- preferred, so noise cannot jump a vehicle to a return leg. [EARLIER_PASS_SLACK_M]
SET VARIABLE vp_earlier_pass_slack_m = 25.0;
-- Metres of fit a point further along must gain per metre along the line to be
-- preferred within one pass: legs drawn on top of each other differ only by
-- rounding. [LATER_FIT_COST]
SET VARIABLE vp_later_fit_cost = 0.01;
-- When the first report fits several passes, traces whose progress differs by
-- less than this are equally good and the schedule settles it. [PROGRESS_TIE_M]
SET VARIABLE vp_progress_tie_m = 50.0;
-- A vehicle silent on a trip for longer than this starts a new run. [RUN_BREAK_S]
SET VARIABLE vp_run_break_s = 10800;
-- Arrival and departure are read this far before and after the stop, shrunk
-- to half the distance to a neighbouring stop so zones never overlap, and
-- never below the minimum. [STOP_ZONE_M]
SET VARIABLE vp_stop_zone_m = 25.0;
SET VARIABLE vp_min_stop_zone_m = 1.0;
-- No crossing is recorded when the reports either side are further apart
-- than this: the time between them would be a guess. [MAX_EVENT_GAP_S]
SET VARIABLE vp_max_event_gap_s = 300;
-- Stop spikes: a turn of at least 75 degrees between two segments of at most
-- 30 m, where the road beyond carries on within 45 degrees of the same
-- direction, is a detour drawn to the curb that no vehicle drives. [geo.rs SPIKE_*]
SET VARIABLE vp_spike_max_segment_m = 30.0;
SET VARIABLE vp_spike_min_turn_deg = 75.0;
SET VARIABLE vp_spike_max_road_turn_deg = 45.0;
-- Placing stops: metres of fit charged per metre along the line, so that a
-- stop fitting two passes equally goes on the earlier one (about 2 m per km);
-- and how far a stop may sit behind the one before it. [LATER_PASS_COST, assign_stop_positions]
SET VARIABLE vp_stop_later_pass_cost = 0.002;
SET VARIABLE vp_stop_overlap_m = 5.0;
-- Grid cell used only to prune which segments are compared with which points.
-- Any size gives the same result; this one keeps the candidate lists short.
SET VARIABLE vp_grid_m = 250.0;
-- [T5] A step whose progress exceeds 2 x the straight-line GPS move + this
-- much (1,500 ft) jumped ahead; its crossings are flagged, not dropped.
SET VARIABLE vp_jump_slack_m = 457.2;

-- Step from (lat1, lon1) to (lat2, lon2) in metres east and north, flat at the
-- step's mid-latitude (geo.rs is_spike).
CREATE OR REPLACE MACRO vp_east_m(lat1, lon1, lat2, lon2) AS
  (lon2 - lon1) * cos(radians((lat1 + lat2) / 2)) * 111320.0;
CREATE OR REPLACE MACRO vp_north_m(lat1, lat2) AS (lat2 - lat1) * 111320.0;
-- Unsigned angle in degrees between two vectors.
CREATE OR REPLACE MACRO vp_turn_deg(ux, uy, vx, vy) AS
  abs(degrees(atan2(ux * vy - uy * vx, ux * vx + uy * vy)));
CREATE OR REPLACE MACRO vp_len(x, y) AS sqrt(x * x + y * y);
-- Is vertex 2 a stop spike, given vertices 0..4 around it (0 and 4 show which
-- way the road runs). NULL neighbours (the ends of the line) give false.
CREATE OR REPLACE MACRO vp_is_spike(lat0, lon0, lat1, lon1, lat2, lon2, lat3, lon3, lat4, lon4) AS
  coalesce(
        vp_len(vp_east_m(lat1, lon1, lat2, lon2), vp_north_m(lat1, lat2)) > 0
    AND vp_len(vp_east_m(lat1, lon1, lat2, lon2), vp_north_m(lat1, lat2)) <= getvariable('vp_spike_max_segment_m')
    AND vp_len(vp_east_m(lat2, lon2, lat3, lon3), vp_north_m(lat2, lat3)) > 0
    AND vp_len(vp_east_m(lat2, lon2, lat3, lon3), vp_north_m(lat2, lat3)) <= getvariable('vp_spike_max_segment_m')
    AND vp_len(vp_east_m(lat0, lon0, lat1, lon1), vp_north_m(lat0, lat1)) > 0
    AND vp_len(vp_east_m(lat3, lon3, lat4, lon4), vp_north_m(lat3, lat4)) > 0
    AND vp_turn_deg(vp_east_m(lat1, lon1, lat2, lon2), vp_north_m(lat1, lat2),
                    vp_east_m(lat2, lon2, lat3, lon3), vp_north_m(lat2, lat3)) >= getvariable('vp_spike_min_turn_deg')
    AND vp_turn_deg(vp_east_m(lat0, lon0, lat1, lon1), vp_north_m(lat0, lat1),
                    vp_east_m(lat3, lon3, lat4, lon4), vp_north_m(lat3, lat4)) <= getvariable('vp_spike_max_road_turn_deg'),
    false);
-- Projecting point p onto the segment (x0, y0) -> (x1, y1): the fraction
-- along it of the nearest point, clamped to the segment, and the distance
-- from p to that point. Segments have positive length (repeats are dropped).
CREATE OR REPLACE MACRO vp_seg_frac(px, py, x0, y0, x1, y1) AS
  greatest(0.0, least(1.0,
    ((px - x0) * (x1 - x0) + (py - y0) * (y1 - y0)) / ((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0))));
CREATE OR REPLACE MACRO vp_seg_offset(px, py, x0, y0, x1, y1) AS
  vp_len(px - (x0 + (x1 - x0) * vp_seg_frac(px, py, x0, y0, x1, y1)),
         py - (y0 + (y1 - y0) * vp_seg_frac(px, py, x0, y0, x1, y1)));

-- ---------------------------------------------------------------------------
-- 1. Lines
-- ---------------------------------------------------------------------------

-- int_vp_trip_pattern: one row per feed_digest and trip_id scheduled on a
-- service day in the build. A pattern is a line plus an ordered stop list;
-- trips sharing both share stop positions. A trip whose shape is missing or
-- has fewer than two usable points gets a straight-line path through its
-- stops (a synthetic line), as in the engine. A trip with fewer than two
-- stops has no pattern and no events.
CREATE OR REPLACE TABLE int_vp_trip_pattern AS
WITH trips AS (
  SELECT DISTINCT feed_digest, trip_id, shape_id FROM fct_scheduled_trip
),
stop_list AS (
  SELECT s.feed_digest, s.trip_id,
         string_agg(s.stop_id, chr(31) ORDER BY s.stop_sequence) AS stop_list,
         count(*) AS n_stops
  FROM int_stop_time s
  JOIN trips USING (feed_digest, trip_id)
  GROUP BY ALL
),
usable_shape AS (
  SELECT feed_digest, shape_id
  FROM stg_shapes
  WHERE shape_pt_lat BETWEEN -90 AND 90 AND shape_pt_lon BETWEEN -180 AND 180
    AND NOT (shape_pt_lat = 0 AND shape_pt_lon = 0)
  GROUP BY ALL
  HAVING count(DISTINCT (shape_pt_lat, shape_pt_lon)) >= 2
),
lined AS (
  SELECT t.feed_digest, t.trip_id, t.shape_id, l.stop_list, l.n_stops,
         u.shape_id IS NULL AS is_synthetic_line,
         CASE WHEN u.shape_id IS NOT NULL THEN 'shape:' || t.shape_id
              ELSE 'stops:' || md5(l.stop_list) END AS line_id
  FROM trips t
  JOIN stop_list l USING (feed_digest, trip_id)
  LEFT JOIN usable_shape u USING (feed_digest, shape_id)
  WHERE l.n_stops >= 2
)
SELECT feed_digest, trip_id, line_id, is_synthetic_line, n_stops,
       md5(line_id || chr(30) || stop_list) AS pattern_id
FROM lined;

-- int_vp_line_vertex: one row per feed_digest, line_id and vertex_index
-- (1-based, in drawing order), including vertices that are then dropped.
--   dropped_as  NULL (kept), 'spike_1', 'spike_2' or 'repeat'
--   x_m, y_m    position in the line's flat frame
-- Vertices are shape points in shape_pt_sequence order, or stop coordinates
-- in stop_sequence order for a synthetic line. Stop spikes are dropped from
-- shapes (not from synthetic lines), then repeated vertices (under 1 cm from
-- the one before).
--
-- Departure from the engine: remove_spikes deletes one vertex at a time and
-- rescans until nothing changes. Here every vertex is tested against its
-- neighbours at once, and that is done twice (spike_1, then spike_2 on what
-- is left). int_vp_line counts both; a second pass that removes almost
-- nothing shows a third would not matter.
CREATE OR REPLACE TABLE int_vp_line_vertex AS
WITH wanted AS (
  SELECT feed_digest, line_id, any_value(is_synthetic_line) AS is_synthetic_line,
         -- any trip of a synthetic line will do: they share one stop list
         min(trip_id) AS a_trip_id
  FROM int_vp_trip_pattern
  GROUP BY ALL
),
raw AS (
  SELECT w.feed_digest, w.line_id, false AS is_synthetic_line,
         s.shape_pt_sequence AS seq, s.shape_pt_lat AS lat, s.shape_pt_lon AS lon
  FROM wanted w
  JOIN stg_shapes s ON s.feed_digest = w.feed_digest AND 'shape:' || s.shape_id = w.line_id
  WHERE NOT w.is_synthetic_line
  UNION ALL
  SELECT w.feed_digest, w.line_id, true, st.stop_sequence, d.stop_lat, d.stop_lon
  FROM wanted w
  JOIN int_stop_time st ON st.feed_digest = w.feed_digest AND st.trip_id = w.a_trip_id
  JOIN stg_stops d ON d.feed_digest = st.feed_digest AND d.stop_id = st.stop_id
  WHERE w.is_synthetic_line
),
usable AS (
  SELECT *, row_number() OVER (PARTITION BY feed_digest, line_id ORDER BY seq, lat, lon) AS vertex_index
  FROM raw
  WHERE lat BETWEEN -90 AND 90 AND lon BETWEEN -180 AND 180 AND NOT (lat = 0 AND lon = 0)
),
spike_1 AS (
  SELECT *,
    NOT is_synthetic_line AND vp_is_spike(
      lag(lat, 2) OVER w, lag(lon, 2) OVER w, lag(lat) OVER w, lag(lon) OVER w, lat, lon,
      lead(lat) OVER w, lead(lon) OVER w, lead(lat, 2) OVER w, lead(lon, 2) OVER w) AS is_spike_1
  FROM usable
  WINDOW w AS (PARTITION BY feed_digest, line_id ORDER BY vertex_index)
),
spike_2 AS (
  SELECT *,
    NOT is_synthetic_line AND vp_is_spike(
      lag(lat, 2) OVER w, lag(lon, 2) OVER w, lag(lat) OVER w, lag(lon) OVER w, lat, lon,
      lead(lat) OVER w, lead(lon) OVER w, lead(lat, 2) OVER w, lead(lon, 2) OVER w) AS is_spike_2
  FROM spike_1
  WHERE NOT is_spike_1
  WINDOW w AS (PARTITION BY feed_digest, line_id ORDER BY vertex_index)
),
frame AS (
  -- Centred on the mean of the vertices left after spike removal. [geo.rs from_lat_lon]
  SELECT feed_digest, line_id, avg(lat) AS lat0, avg(lon) AS lon0,
         greatest(abs(cos(radians(avg(lat)))), 0.01) AS cos_lat
  FROM spike_2 WHERE NOT is_spike_2
  GROUP BY ALL
),
projected AS (
  SELECT s.feed_digest, s.line_id, s.vertex_index, s.is_synthetic_line, s.lat, s.lon,
         f.lat0, f.lon0, f.cos_lat,
         (s.lon - f.lon0) * f.cos_lat * 111320.0 AS x_m,
         (s.lat - f.lat0) * 111320.0 AS y_m,
         CASE WHEN s.is_spike_1 THEN 'spike_1' WHEN s2.is_spike_2 THEN 'spike_2' END AS dropped_as
  FROM spike_1 s
  LEFT JOIN spike_2 s2 USING (feed_digest, line_id, vertex_index)
  JOIN frame f USING (feed_digest, line_id)
)
SELECT feed_digest, line_id, vertex_index, is_synthetic_line, lat, lon, lat0, lon0, cos_lat, x_m, y_m,
       CASE WHEN dropped_as IS NULL
             AND vp_len(x_m - lag(x_m) OVER w, y_m - lag(y_m) OVER w) <= 0.01 THEN 'repeat'
            ELSE dropped_as END AS dropped_as
FROM projected
-- the window runs over the vertices still in play, so 'repeat' compares
-- with the previous vertex that survived spike removal
WINDOW w AS (PARTITION BY feed_digest, line_id, dropped_as IS NULL ORDER BY vertex_index);

-- int_vp_line_segment: one row per feed_digest, line_id and seg_index
-- (1-based, consecutive over the kept vertices).
--   s0_m, s1_m  distance along the line at the segment's start and end
CREATE OR REPLACE TABLE int_vp_line_segment AS
WITH seg AS (
  SELECT feed_digest, line_id,
         row_number() OVER w AS seg_index,
         x_m AS x0, y_m AS y0, lead(x_m) OVER w AS x1, lead(y_m) OVER w AS y1
  FROM int_vp_line_vertex
  WHERE dropped_as IS NULL
  WINDOW w AS (PARTITION BY feed_digest, line_id ORDER BY vertex_index)
)
SELECT feed_digest, line_id, seg_index, x0, y0, x1, y1,
       coalesce(sum(vp_len(x1 - x0, y1 - y0)) OVER prior, 0) AS s0_m,
       sum(vp_len(x1 - x0, y1 - y0)) OVER upto AS s1_m
FROM seg
WHERE x1 IS NOT NULL
WINDOW prior AS (PARTITION BY feed_digest, line_id ORDER BY seg_index
                 ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),
       upto  AS (PARTITION BY feed_digest, line_id ORDER BY seg_index
                 ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
ORDER BY feed_digest, line_id, seg_index;

-- int_vp_line: one row per feed_digest and line_id with at least one
-- segment: its frame, length and how many vertices were dropped.
CREATE OR REPLACE TABLE int_vp_line AS
SELECT v.feed_digest, v.line_id,
       any_value(v.is_synthetic_line) AS is_synthetic_line,
       any_value(v.lat0) AS lat0, any_value(v.lon0) AS lon0, any_value(v.cos_lat) AS cos_lat,
       s.length_m, s.n_segments,
       count(*) AS n_vertices_raw,
       count(*) FILTER (WHERE v.dropped_as = 'spike_1') AS n_spikes_1,
       count(*) FILTER (WHERE v.dropped_as = 'spike_2') AS n_spikes_2,
       count(*) FILTER (WHERE v.dropped_as = 'repeat')  AS n_repeats
FROM int_vp_line_vertex v
JOIN (SELECT feed_digest, line_id, max(s1_m) AS length_m, count(*) AS n_segments
      FROM int_vp_line_segment GROUP BY ALL) s USING (feed_digest, line_id)
GROUP BY v.feed_digest, v.line_id, s.length_m, s.n_segments;

-- int_vp_segment_cell: one row per segment and grid cell within reach of it
-- (the segment's bounding box grown by the max offset). Used only to prune:
-- a point is compared with the segments listed for its own cell.
CREATE OR REPLACE TABLE int_vp_segment_cell AS
WITH g AS (SELECT getvariable('vp_grid_m') AS g, getvariable('vp_max_offset_m') AS r)
SELECT s.feed_digest, s.line_id, s.seg_index, cx, cy
FROM int_vp_line_segment s, g,
     unnest(range(CAST(floor((least(s.x0, s.x1) - g.r) / g.g) AS BIGINT),
                  CAST(floor((greatest(s.x0, s.x1) + g.r) / g.g) AS BIGINT) + 1)) AS ux(cx),
     unnest(range(CAST(floor((least(s.y0, s.y1) - g.r) / g.g) AS BIGINT),
                  CAST(floor((greatest(s.y0, s.y1) + g.r) / g.g) AS BIGINT) + 1)) AS uy(cy);

-- ---------------------------------------------------------------------------
-- 2. Points to place on lines: pattern stops and vehicle reports
-- ---------------------------------------------------------------------------

-- int_vp_pattern_stop_raw: one row per feed_digest, pattern_id and stop_index
-- (1-based position in the pattern's stop list).
CREATE OR REPLACE TABLE int_vp_pattern_stop_raw AS
WITH one_trip AS (
  SELECT feed_digest, pattern_id, any_value(line_id) AS line_id, min(trip_id) AS trip_id
  FROM int_vp_trip_pattern GROUP BY ALL
)
SELECT o.feed_digest, o.pattern_id, o.line_id, st.stop_index, st.stop_id,
       d.stop_lat, d.stop_lon,
       (d.stop_lon - l.lon0) * l.cos_lat * 111320.0 AS x,
       (d.stop_lat - l.lat0) * 111320.0 AS y,
       count(*) OVER (PARTITION BY o.feed_digest, o.pattern_id) AS n_stops
FROM one_trip o
JOIN int_vp_line l USING (feed_digest, line_id)
JOIN int_stop_time st ON st.feed_digest = o.feed_digest AND st.trip_id = o.trip_id
LEFT JOIN stg_stops d ON d.feed_digest = st.feed_digest AND d.stop_id = st.stop_id;

-- int_vp_run: one row per run. A run is one vehicle's reports for one trip on
-- one service date, split where the vehicle is silent on it for over three
-- hours. Only trips scheduled on that date, with a pattern, are matched;
-- reports for others are counted in qa_vp_report_funnel.
-- int_vp_report: one row per run_id and report_index (time order).
CREATE OR REPLACE TABLE int_vp_report AS
WITH r AS (
  SELECT v.system_key, v.service_date, v.trip_id, v.vehicle_id, v.position_ts, v.lat, v.lon,
         t.feed_digest, p.pattern_id, p.line_id
  FROM stg_vehicle_position v
  JOIN fct_scheduled_trip t USING (system_key, service_date, trip_id)
  JOIN int_vp_trip_pattern p USING (feed_digest, trip_id)
  JOIN int_vp_line l USING (feed_digest, line_id)
  -- Two reports of one vehicle and trip at one instant (start_date given on
  -- one and not the other): keep the first captured.
  QUALIFY row_number() OVER (
    PARTITION BY v.system_key, v.service_date, v.trip_id, v.vehicle_id, v.position_ts
    ORDER BY v.fetch_ts, v.lat, v.lon) = 1
),
breaks AS (
  SELECT *,
    coalesce(epoch(position_ts) - epoch(lag(position_ts) OVER w) > getvariable('vp_run_break_s'), false)::INTEGER AS new_run
  FROM r
  WINDOW w AS (PARTITION BY system_key, service_date, trip_id, vehicle_id ORDER BY position_ts)
),
numbered AS (
  SELECT *,
    sum(new_run) OVER (PARTITION BY system_key, service_date, trip_id, vehicle_id ORDER BY position_ts) AS run_part
  FROM breaks
)
SELECT
  dense_rank() OVER (ORDER BY system_key, service_date, trip_id, vehicle_id, run_part) AS run_id,
  row_number() OVER (PARTITION BY system_key, service_date, trip_id, vehicle_id, run_part ORDER BY position_ts) AS report_index,
  n.system_key, n.service_date, n.trip_id, n.vehicle_id, n.feed_digest, n.pattern_id, n.line_id,
  n.position_ts, epoch(n.position_ts) AS t, n.lat, n.lon,
  (n.lon - l.lon0) * l.cos_lat * 111320.0 AS x,
  (n.lat - l.lat0) * 111320.0 AS y
FROM numbered n
JOIN int_vp_line l USING (feed_digest, line_id);

CREATE OR REPLACE TABLE int_vp_run AS
SELECT r.run_id, r.system_key, r.service_date, r.trip_id, r.vehicle_id, r.feed_digest,
       r.pattern_id, r.line_id,
       count(*) AS n_reports, min(r.position_ts) AS first_report_ts, max(r.position_ts) AS last_report_ts,
       -- Reach per second: 150 mph on rail and ferry, else 80 mph. dim_route
       -- puts trolleybus (11) with tram, so it gets the rail figure here.
       CASE WHEN any_value(d.mode) IN ('tram', 'subway', 'rail', 'ferry')
            THEN getvariable('vp_rail_max_mps') ELSE getvariable('vp_street_max_mps') END AS max_mps
FROM int_vp_report r
JOIN fct_scheduled_trip t USING (system_key, service_date, trip_id)
LEFT JOIN dim_route d ON d.system_key = t.system_key AND d.feed_digest = t.feed_digest AND d.route_id = t.route_id
GROUP BY ALL;

-- int_vp_pass: one row per point and pass of its line within reach of it.
--   point_kind  'stop' (point_id = pattern stop) or 'report' (point_id = report)
--   pass_s_m    where on the line the pass comes closest to the point
--   offset_m    how far the point is from the line there
--   span_lo_m, span_hi_m  the stretch of line within reach around this pass
--
-- A pass is a closest approach. Segments within reach of the point form
-- stretches of consecutive segments; in each stretch, each local minimum of
-- distance is a candidate, and a candidate is dropped when another one in its
-- stretch within 240 m along the line fits better (by offset plus 0.01 m per
-- metre further along, as within one pass in the engine).
--
-- Departure from the engine: geo.rs candidates() walks segments once and
-- splits a stretch where it runs on more than 240 m past the best point so
-- far. The local-minimum rule gives the same passes on ordinary loops and
-- out-and-backs and is easier to state; it can keep two candidates on one
-- winding pass, which the trace handles by preferring the earlier one.
CREATE OR REPLACE TABLE int_vp_pass AS
WITH point AS (
  SELECT 'stop' AS point_kind, hash(feed_digest, pattern_id, stop_index) AS point_id,
         feed_digest, line_id, x, y
  FROM int_vp_pattern_stop_raw
  WHERE x IS NOT NULL
  UNION ALL
  SELECT 'report', hash(run_id, report_index), feed_digest, line_id, x, y
  FROM int_vp_report
),
near AS (
  SELECT p.point_kind, p.point_id, s.seg_index,
         s.s0_m + (s.s1_m - s.s0_m) * vp_seg_frac(p.x, p.y, s.x0, s.y0, s.x1, s.y1) AS s_m,
         vp_seg_offset(p.x, p.y, s.x0, s.y0, s.x1, s.y1) AS offset_m
  FROM point p
  JOIN int_vp_segment_cell c
    ON c.feed_digest = p.feed_digest AND c.line_id = p.line_id
   AND c.cx = CAST(floor(p.x / getvariable('vp_grid_m')) AS BIGINT)
   AND c.cy = CAST(floor(p.y / getvariable('vp_grid_m')) AS BIGINT)
  JOIN int_vp_line_segment s
    ON s.feed_digest = c.feed_digest AND s.line_id = c.line_id AND s.seg_index = c.seg_index
),
within AS (
  SELECT * FROM near WHERE offset_m <= getvariable('vp_max_offset_m')
),
stretch AS (
  SELECT *,
    seg_index - row_number() OVER (PARTITION BY point_kind, point_id ORDER BY seg_index) AS stretch_id,
    lag(offset_m)  OVER (PARTITION BY point_kind, point_id ORDER BY seg_index) AS prev_offset,
    lag(seg_index) OVER (PARTITION BY point_kind, point_id ORDER BY seg_index) AS prev_seg,
    lead(offset_m)  OVER (PARTITION BY point_kind, point_id ORDER BY seg_index) AS next_offset,
    lead(seg_index) OVER (PARTITION BY point_kind, point_id ORDER BY seg_index) AS next_seg
  FROM within
),
spans AS (
  SELECT *,
    min(s_m) OVER (PARTITION BY point_kind, point_id, stretch_id) AS span_lo_m,
    max(s_m) OVER (PARTITION BY point_kind, point_id, stretch_id) AS span_hi_m
  FROM stretch
),
local_min AS (
  -- A plateau (the point nearest a shared vertex fits both segments equally)
  -- yields its last segment only.
  SELECT * FROM spans
  WHERE (prev_seg IS DISTINCT FROM seg_index - 1 OR offset_m <= prev_offset)
    AND (next_seg IS DISTINCT FROM seg_index + 1 OR offset_m < next_offset)
),
merged AS (
  SELECT a.*
  FROM local_min a
  ANTI JOIN local_min b
    ON b.point_kind = a.point_kind AND b.point_id = a.point_id AND b.stretch_id = a.stretch_id
   AND b.seg_index <> a.seg_index
   AND abs(b.s_m - a.s_m) <= getvariable('vp_pass_split_m')
   AND (b.offset_m + getvariable('vp_later_fit_cost') * b.s_m, b.seg_index)
     < (a.offset_m + getvariable('vp_later_fit_cost') * a.s_m, a.seg_index)
)
SELECT point_kind, point_id,
       row_number() OVER (PARTITION BY point_kind, point_id ORDER BY s_m, seg_index) AS pass_index,
       s_m AS pass_s_m, offset_m, span_lo_m, span_hi_m
FROM merged;

-- ---------------------------------------------------------------------------
-- 3. Stops placed along the line
-- ---------------------------------------------------------------------------

-- int_vp_pattern_stop: one row per feed_digest, pattern_id and stop_index.
--   stop_s_m        position along the line
--   stop_offset_m   distance from the stop to the line there
--   zone_m          how far before and after the stop arrival and departure are read
--
-- As in the engine (geo.rs assign_stop_positions), stops are placed by dynamic
-- programming over every pass of the line near each stop: positions keep the
-- stop order (a stop may sit up to 5 m behind the one before) and minimise
-- the total of offset + 0.002 x position. Ties go to the earlier pass. A stop
-- no pass reaches within 120 m goes to the nearest point of the whole line.
-- A stop without coordinates is not placed and gets no events.
CREATE OR REPLACE TABLE int_vp_pattern_stop AS
WITH RECURSIVE placeable AS (
  SELECT *, row_number() OVER (PARTITION BY feed_digest, pattern_id ORDER BY stop_index) AS k
  FROM int_vp_pattern_stop_raw
  WHERE x IS NOT NULL
),
fallback AS (
  -- Nearest point on the whole line, for stops no pass reaches.
  SELECT p.feed_digest, p.pattern_id, p.stop_index,
         arg_min(s.s0_m + (s.s1_m - s.s0_m) * vp_seg_frac(p.x, p.y, s.x0, s.y0, s.x1, s.y1),
                 (vp_seg_offset(p.x, p.y, s.x0, s.y0, s.x1, s.y1), s.seg_index)) AS pass_s_m,
         min(vp_seg_offset(p.x, p.y, s.x0, s.y0, s.x1, s.y1)) AS offset_m
  FROM placeable p
  JOIN int_vp_line_segment s USING (feed_digest, line_id)
  WHERE NOT EXISTS (SELECT 1 FROM int_vp_pass c
                    WHERE c.point_kind = 'stop' AND c.point_id = hash(p.feed_digest, p.pattern_id, p.stop_index))
  GROUP BY ALL
),
candidate AS (
  SELECT p.feed_digest, p.pattern_id, p.k, c.pass_index, c.pass_s_m, c.offset_m,
         c.offset_m + getvariable('vp_stop_later_pass_cost') * c.pass_s_m AS cost
  FROM placeable p
  JOIN int_vp_pass c ON c.point_kind = 'stop' AND c.point_id = hash(p.feed_digest, p.pattern_id, p.stop_index)
  UNION ALL
  SELECT p.feed_digest, p.pattern_id, p.k, 1, f.pass_s_m, f.offset_m,
         f.offset_m + getvariable('vp_stop_later_pass_cost') * f.pass_s_m
  FROM placeable p JOIN fallback f USING (feed_digest, pattern_id, stop_index)
),
-- best(k, j): the lowest total cost of placing stops 1..k with stop k on
-- candidate j, and the candidate chosen for each stop on the way there.
best(feed_digest, pattern_id, k, pass_index, pass_s_m, total_cost, path) AS (
  SELECT feed_digest, pattern_id, k, pass_index, pass_s_m, cost, [pass_index]
  FROM candidate WHERE k = 1
  UNION ALL
  SELECT c.feed_digest, c.pattern_id, c.k, c.pass_index, c.pass_s_m,
         min(b.total_cost + c.cost + CASE WHEN b.pass_s_m <= c.pass_s_m + getvariable('vp_stop_overlap_m') THEN 0 ELSE 1e6 END),
         list_append(
           arg_min(b.path, [b.total_cost + c.cost + CASE WHEN b.pass_s_m <= c.pass_s_m + getvariable('vp_stop_overlap_m') THEN 0 ELSE 1e6 END,
                            b.pass_index]),
           c.pass_index)
  FROM best b
  JOIN candidate c ON c.feed_digest = b.feed_digest AND c.pattern_id = b.pattern_id AND c.k = b.k + 1
  GROUP BY c.feed_digest, c.pattern_id, c.k, c.pass_index, c.pass_s_m, c.cost
),
chosen_path AS (
  SELECT b.feed_digest, b.pattern_id, arg_min(b.path, [b.total_cost, b.pass_index]) AS path
  FROM best b
  JOIN (SELECT feed_digest, pattern_id, max(k) AS k FROM placeable GROUP BY ALL) last USING (feed_digest, pattern_id, k)
  GROUP BY ALL
),
placed AS (
  SELECT p.feed_digest, p.pattern_id, p.k, p.stop_index, c.pass_s_m, c.offset_m
  FROM chosen_path cp
  JOIN placeable p USING (feed_digest, pattern_id)
  JOIN candidate c ON c.feed_digest = p.feed_digest AND c.pattern_id = p.pattern_id AND c.k = p.k
                  AND c.pass_index = cp.path[p.k]
),
ordered AS (
  -- Remove any residual overlap so positions never decrease.
  SELECT *, max(pass_s_m) OVER (PARTITION BY feed_digest, pattern_id ORDER BY k
                                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS stop_s_m
  FROM placed
),
gaps AS (
  SELECT *,
    stop_s_m - lag(stop_s_m) OVER w  AS gap_before_m,
    lead(stop_s_m) OVER w - stop_s_m AS gap_after_m
  FROM ordered
  WINDOW w AS (PARTITION BY feed_digest, pattern_id ORDER BY k)
)
SELECT r.feed_digest, r.pattern_id, r.line_id, r.stop_index, r.stop_id, r.n_stops,
       r.stop_index = r.n_stops AS is_last_stop,
       g.stop_s_m, g.offset_m AS stop_offset_m,
       greatest(least(getvariable('vp_stop_zone_m'),
                      coalesce(g.gap_before_m / 2, 1e9), coalesce(g.gap_after_m / 2, 1e9)),
                getvariable('vp_min_stop_zone_m')) AS zone_m
FROM int_vp_pattern_stop_raw r
LEFT JOIN gaps g USING (feed_digest, pattern_id, stop_index);

-- ---------------------------------------------------------------------------
-- 4. Following each run along its line
-- ---------------------------------------------------------------------------

-- int_vp_step: one row per run, step and candidate pass (a row with a NULL
-- pass when the report fits no pass). Step 1 is the run's first report that
-- fits any pass; reports before it are off route. Sorted by step so that each
-- round of the recursion below reads only the rows for that step.
CREATE OR REPLACE TABLE int_vp_step AS
WITH fit AS (
  SELECT r.run_id, r.report_index, r.t, p.pass_index, p.pass_s_m, p.offset_m, p.span_lo_m, p.span_hi_m
  FROM int_vp_report r
  LEFT JOIN int_vp_pass p ON p.point_kind = 'report' AND p.point_id = hash(r.run_id, r.report_index)
),
first_fit AS (
  SELECT run_id, min(report_index) AS first_index FROM fit WHERE pass_index IS NOT NULL GROUP BY ALL
)
SELECT f.run_id, f.report_index - ff.first_index + 1 AS step, f.report_index, f.t,
       f.pass_index, f.pass_s_m, f.offset_m, f.span_lo_m, f.span_hi_m, u.max_mps
FROM fit f
JOIN first_fit ff USING (run_id)
JOIN int_vp_run u USING (run_id)
WHERE f.report_index >= ff.first_index
ORDER BY step, run_id, pass_index;

-- int_vp_trace_try: one row per run, starting pass and step: the trace that
-- starts from that pass of the run's first fitting report.
--   s_m    position after this step (the last position, if the report was skipped)
--   is_kept  false when the report fit no pass in the window (off route)
--
-- Rules for each later report (trace.rs follow_from), from the last kept
-- position s at time t:
--   window   [s - 60 m, s + max speed x elapsed + 200 m]. A pass whose
--            closest point lies outside the window, but whose stretch reaches
--            into it, is taken at the window's edge.
--   fit      within 120 m, as everywhere
--   choice   the earliest pass (lowest position) whose fit is within 25 m of
--            the best fit in the window
--   forward  the new position is max(chosen, s): a report landing behind is
--            held at s, and counted as backward when more than 30 m behind
--   skip     a report with no pass in the window is off route; s and t stay
--
-- Departures from the engine:
--   - The engine searches the window segment by segment. Here the window is
--     applied to passes. For a pass taken at the window's edge, the distance
--     from the report to the line at the edge is estimated as if the line
--     ran straight from the pass's closest point:
--       sqrt(offset^2 + (closest point - edge)^2)
--   - The engine, near the end of the line, looks 150 m ahead for a better
--     fit so that a hook at the terminal is reached. Not copied: within one
--     pass the best-fitting point already wins (see int_vp_pass).
CREATE OR REPLACE TABLE int_vp_trace_try AS
WITH RECURSIVE trace(run_id, start_pass, step, t, s_m, is_kept, n_off_route, n_backward) AS (
  SELECT run_id, pass_index, step, t, pass_s_m, true, 0, 0
  FROM int_vp_step
  WHERE step = 1 AND pass_index IS NOT NULL
  UNION ALL
  SELECT run_id, start_pass, step,
         CASE WHEN chosen_s IS NOT NULL THEN t_next ELSE t END,
         CASE WHEN chosen_s IS NOT NULL THEN greatest(chosen_s, s_m) ELSE s_m END,
         chosen_s IS NOT NULL,
         n_off_route + CASE WHEN chosen_s IS NULL THEN 1 ELSE 0 END,
         n_backward + CASE WHEN chosen_s < s_m - getvariable('vp_backward_count_m') THEN 1 ELSE 0 END
  FROM (
    -- choice: the earliest pass within the slack of the best fit
    SELECT run_id, start_pass, step, t_next, t, s_m, n_off_route, n_backward,
           min(at_s_m) FILTER (WHERE at_offset_m <= best_offset_m + getvariable('vp_earlier_pass_slack_m')) AS chosen_s
    FROM (
      SELECT *, min(at_offset_m) OVER (PARTITION BY run_id, start_pass) AS best_offset_m
      FROM (
        -- Each pass of the next report, taken at its nearest point inside the
        -- window. at_* stay NULL for a pass the window does not reach, or that
        -- is too far from the report there, so the state row survives when
        -- nothing fits.
        SELECT v.*,
               greatest(lo_m, least(hi_m, pass_s_m)) AS edge_s_m,
               sqrt(offset_m * offset_m + pow(pass_s_m - edge_s_m, 2)) AS edge_offset_m,
               coalesce(span_hi_m >= lo_m AND span_lo_m <= hi_m
                        AND edge_offset_m <= getvariable('vp_max_offset_m'), false) AS fits,
               CASE WHEN fits THEN edge_s_m END AS at_s_m,
               CASE WHEN fits THEN edge_offset_m END AS at_offset_m
        FROM (
          SELECT tr.run_id, tr.start_pass, st.step, st.t AS t_next, tr.t, tr.s_m, tr.n_off_route, tr.n_backward,
                 st.pass_s_m, st.offset_m, st.span_lo_m, st.span_hi_m,
                 tr.s_m - getvariable('vp_back_window_m') AS lo_m,
                 tr.s_m + st.max_mps * (st.t - tr.t) + getvariable('vp_reach_slack_m') AS hi_m
          FROM trace tr
          JOIN int_vp_step st ON st.run_id = tr.run_id AND st.step = tr.step + 1
        ) v
      ) a
    ) b
    GROUP BY ALL
  )
)
SELECT * FROM trace;

-- int_vp_trace_choice: one row per run: which starting pass explains the run
-- best. As in the engine (trace.rs match_fixes): fewest off-route reports,
-- then the most progress, with progress within 50 m counted as a tie, which
-- goes to the pass nearest where the schedule expects the vehicle at the
-- first report; then the earlier pass.
CREATE OR REPLACE TABLE int_vp_trace_choice AS
WITH attempt AS (
  SELECT run_id, start_pass,
         max(n_off_route) AS n_off_route,
         max(n_backward)  AS n_backward,
         max(s_m) - arg_min(s_m, step) AS progress_m,
         arg_min(s_m, step) AS start_s_m,
         arg_min(t, step) AS start_t,
         count(*) FILTER (WHERE is_kept) AS n_points
  FROM int_vp_trace_try
  GROUP BY ALL
),
-- Where the schedule puts the vehicle at the first fitting report: between
-- the last stop departed and the next, in proportion to time. Before the
-- first departure, the first stop; after the last, the last stop. [day.rs expected_position]
sched AS (
  SELECT u.run_id, st.stop_index, epoch(st.departure_ts) AS dep_t, ps.stop_s_m
  FROM int_vp_run u
  JOIN fct_scheduled_stop_time st USING (system_key, service_date, trip_id)
  JOIN int_vp_pattern_stop ps ON ps.feed_digest = u.feed_digest AND ps.pattern_id = u.pattern_id
                             AND ps.stop_index = st.stop_index
  WHERE ps.stop_s_m IS NOT NULL
),
bracket AS (
  SELECT a.run_id, a.start_pass,
         arg_max(s.stop_s_m, s.stop_index) FILTER (WHERE s.dep_t <= a.start_t) AS s0,
         max(s.dep_t) FILTER (WHERE s.dep_t <= a.start_t) AS t0,
         arg_min(s.stop_s_m, s.stop_index) FILTER (WHERE s.dep_t > a.start_t) AS s1,
         min(s.dep_t) FILTER (WHERE s.dep_t > a.start_t) AS t1,
         arg_min(s.stop_s_m, s.stop_index) AS first_s,
         arg_max(s.stop_s_m, s.stop_index) AS last_s
  FROM attempt a
  JOIN sched s USING (run_id)
  GROUP BY ALL
),
scored AS (
  SELECT a.*,
    abs(a.start_s_m - CASE
      WHEN b.s0 IS NULL THEN b.first_s
      WHEN b.s1 IS NULL THEN b.last_s
      ELSE b.s0 + (b.s1 - b.s0) * (a.start_t - b.t0) / nullif(b.t1 - b.t0, 0)
    END) AS schedule_miss_m,
    min(a.n_off_route) OVER (PARTITION BY a.run_id) AS fewest_off_route
  FROM attempt a
  LEFT JOIN bracket b USING (run_id, start_pass)
),
contenders AS (
  SELECT *, max(progress_m) OVER (PARTITION BY run_id) AS most_progress_m
  FROM scored
  WHERE n_off_route = fewest_off_route
)
SELECT run_id, start_pass, n_off_route, n_backward, progress_m, n_points,
       count(*) OVER (PARTITION BY run_id) AS n_start_passes_tied
FROM contenders
WHERE progress_m >= most_progress_m - getvariable('vp_progress_tie_m')
QUALIFY row_number() OVER (PARTITION BY run_id ORDER BY schedule_miss_m NULLS LAST, start_pass) = 1;

-- int_vp_trace_point: one row per run_id and step that was kept: the run's
-- progress along its line, never decreasing.
CREATE OR REPLACE TABLE int_vp_trace_point AS
SELECT tr.run_id, tr.step, tr.t, tr.s_m, r.lat, r.lon
FROM int_vp_trace_try tr
JOIN int_vp_trace_choice c USING (run_id, start_pass)
JOIN (SELECT DISTINCT run_id, step, report_index FROM int_vp_step) st USING (run_id, step)
JOIN int_vp_report r ON r.run_id = st.run_id AND r.report_index = st.report_index
WHERE tr.is_kept;

-- Match quality on the run.
CREATE OR REPLACE TABLE int_vp_run AS
SELECT u.*,
       -- reports before the first fitting one are off route too
       coalesce(c.n_off_route + (f.first_index - 1), u.n_reports) AS n_off_route,
       c.n_backward, c.n_points, c.progress_m, c.n_start_passes_tied,
       coalesce(c.n_off_route + (f.first_index - 1), u.n_reports) / u.n_reports AS off_route_share,
       c.progress_m / l.length_m AS progress_share
FROM int_vp_run u
JOIN int_vp_line l USING (feed_digest, line_id)
LEFT JOIN int_vp_trace_choice c USING (run_id)
LEFT JOIN (SELECT run_id, min(report_index) AS first_index FROM int_vp_step GROUP BY ALL) f USING (run_id);

-- ---------------------------------------------------------------------------
-- 5. Crossings
-- ---------------------------------------------------------------------------

-- int_vp_stop_crossing: one row per run_id and stop_index of its pattern.
-- A crossing of a point P is the first time progress reaches P (trace.rs
-- crossing_time): the trace step from (t0, s0) to (t1, s1) with s0 < P <= s1,
-- interpolated linearly. There is none when the run's first position is
-- already at or past P, when it never reaches P, or when t1 - t0 > 300 s.
--   arrival    P = stop - zone          departure  P = stop + zone
-- Each *_gap_s is t1 - t0 of the bracketing reports, kept even when the
-- crossing itself is withheld, so that misses can be explained.
CREATE OR REPLACE TABLE int_vp_stop_crossing AS
WITH step AS (
  SELECT run_id, lag(t) OVER w AS t0, lag(s_m) OVER w AS s0, t AS t1, s_m AS s1,
         -- [T5] progress over twice the straight-line GPS move plus 457.2 m
         -- (1,500 ft) is a match that jumped ahead along the line.
         s_m - lag(s_m) OVER w > 2 * haversine_m(lag(lat) OVER w, lag(lon) OVER w, lat, lon)
                                 + getvariable('vp_jump_slack_m') AS is_jump
  FROM int_vp_trace_point
  WINDOW w AS (PARTITION BY run_id ORDER BY step)
),
moving AS (SELECT * FROM step WHERE s0 < s1),
target AS (
  SELECT u.run_id, ps.stop_index, ps.stop_id, ps.is_last_stop, ps.stop_s_m, ps.zone_m,
         ps.stop_s_m - ps.zone_m AS arrive_at_m, ps.stop_s_m + ps.zone_m AS depart_at_m
  FROM int_vp_run u
  JOIN int_vp_pattern_stop ps USING (feed_digest, pattern_id)
  WHERE ps.stop_s_m IS NOT NULL
),
arr AS (
  SELECT g.run_id, g.stop_index, m.t1 - m.t0 AS gap_s, m.is_jump,
         m.t0 + (g.arrive_at_m - m.s0) / (m.s1 - m.s0) * (m.t1 - m.t0) AS t
  FROM target g JOIN moving m ON m.run_id = g.run_id AND m.s0 < g.arrive_at_m AND g.arrive_at_m <= m.s1
),
dep AS (
  SELECT g.run_id, g.stop_index, m.t1 - m.t0 AS gap_s, m.is_jump,
         m.t0 + (g.depart_at_m - m.s0) / (m.s1 - m.s0) * (m.t1 - m.t0) AS t
  FROM target g JOIN moving m ON m.run_id = g.run_id AND m.s0 < g.depart_at_m AND g.depart_at_m <= m.s1
),
span AS (
  SELECT run_id, min(s_m) AS first_s_m, max(s_m) AS last_s_m FROM int_vp_trace_point GROUP BY ALL
)
SELECT g.run_id, g.stop_index, g.stop_id, g.is_last_stop, g.stop_s_m, g.zone_m,
       CASE WHEN a.gap_s <= getvariable('vp_max_event_gap_s') THEN to_timestamp(a.t) END AS arrival_ts,
       CASE WHEN d.gap_s <= getvariable('vp_max_event_gap_s') THEN to_timestamp(d.t) END AS departure_ts,
       a.gap_s AS arrival_gap_s,
       d.gap_s AS departure_gap_s,
       coalesce(a.is_jump, false) OR coalesce(d.is_jump, false) AS is_bracket_jump,
       -- Why there is no crossing, for the stop's pass (departure, or arrival
       -- at the last stop).
       CASE
         WHEN sp.run_id IS NULL THEN 'run_not_matched'
         WHEN (CASE WHEN g.is_last_stop THEN g.arrive_at_m ELSE g.depart_at_m END) <= sp.first_s_m THEN 'trace_started_past'
         WHEN (CASE WHEN g.is_last_stop THEN g.arrive_at_m ELSE g.depart_at_m END) > sp.last_s_m THEN 'trace_ended_before'
         WHEN (CASE WHEN g.is_last_stop THEN a.gap_s ELSE d.gap_s END) > getvariable('vp_max_event_gap_s') THEN 'long_gap'
       END AS miss_reason
FROM target g
LEFT JOIN arr a USING (run_id, stop_index)
LEFT JOIN dep d USING (run_id, stop_index)
LEFT JOIN span sp USING (run_id);

-- ---------------------------------------------------------------------------
-- 6. Stop events
-- ---------------------------------------------------------------------------

-- fct_stop_event_vp: one row per system_key, service_date, trip_id and
-- stop_sequence with an observed arrival or departure.
--   arrival_ts     progress crossed `zone_m` before the stop
--   departure_ts   progress crossed `zone_m` past the stop
--   observed_ts    the stop's pass as the engine reads it: the departure,
--                  except at the last stop, where it is the arrival
--   bracket_gap_s  seconds between the reports bracketing observed_ts (or,
--                  when the stop has only the other crossing, that one's);
--                  the timing is only as precise as this
-- Several runs can cover one trip (a vehicle change mid-trip, or two vehicles
-- logged on it). Each stop takes its event from one run: one that observed
-- the stop's pass (observed_ts) if any did, then the run with the most
-- crossings on the trip, the lower off-route share, the shorter bracket, and
-- the lower vehicle_id. n_runs_with_event says when there was a choice.
CREATE OR REPLACE TABLE fct_stop_event_vp AS
WITH ev AS (
  SELECT u.system_key, u.service_date, u.trip_id, u.vehicle_id, u.run_id,
         u.off_route_share, u.n_reports, u.feed_digest,
         c.*,
         CASE WHEN c.is_last_stop THEN c.arrival_ts ELSE c.departure_ts END AS observed_ts,
         CASE WHEN c.is_last_stop THEN c.arrival_gap_s ELSE c.departure_gap_s END AS observed_gap_s,
         count(c.arrival_ts) OVER (PARTITION BY u.run_id) + count(c.departure_ts) OVER (PARTITION BY u.run_id) AS run_crossings
  FROM int_vp_stop_crossing c
  JOIN int_vp_run u USING (run_id)
  WHERE c.arrival_ts IS NOT NULL OR c.departure_ts IS NOT NULL
)
SELECT
  ev.system_key,
  ev.service_date,
  ev.trip_id,
  st.stop_sequence,
  ev.stop_index,
  ev.stop_id,
  ev.vehicle_id,
  ev.arrival_ts,
  ev.departure_ts,
  ev.observed_ts,
  CASE WHEN ev.observed_ts IS NULL THEN NULL WHEN ev.is_last_stop THEN 'arrival' ELSE 'departure' END AS observed_basis,
  coalesce(ev.observed_gap_s,
           CASE WHEN ev.is_last_stop THEN ev.departure_gap_s ELSE ev.arrival_gap_s END) AS bracket_gap_s,
  CASE WHEN ev.arrival_ts IS NOT NULL THEN ev.arrival_gap_s END   AS arrival_bracket_gap_s,
  CASE WHEN ev.departure_ts IS NOT NULL THEN ev.departure_gap_s END AS departure_bracket_gap_s,
  ev.is_last_stop,
  ev.stop_s_m,
  ev.zone_m,
  -- The bracketing step fails [T5]: progress far beyond the GPS movement, so
  -- the match probably jumped ahead and the time is a straight-line guess.
  -- Kept (the engine keeps these events too); filter on it for strict use.
  ev.is_bracket_jump,
  ps.stop_offset_m,
  l.is_synthetic_line,
  ev.off_route_share AS run_off_route_share,
  ev.n_reports AS run_n_reports,
  ev.run_id,
  count(*) OVER (PARTITION BY ev.system_key, ev.service_date, ev.trip_id, ev.stop_index) AS n_runs_with_event
FROM ev
JOIN int_vp_run u USING (run_id)
JOIN int_vp_pattern_stop ps ON ps.feed_digest = u.feed_digest AND ps.pattern_id = u.pattern_id AND ps.stop_index = ev.stop_index
JOIN int_vp_line l ON l.feed_digest = u.feed_digest AND l.line_id = u.line_id
JOIN fct_scheduled_stop_time st
  ON st.system_key = ev.system_key AND st.service_date = ev.service_date
 AND st.trip_id = ev.trip_id AND st.stop_index = ev.stop_index
QUALIFY row_number() OVER (
  PARTITION BY ev.system_key, ev.service_date, ev.trip_id, ev.stop_index
  ORDER BY ev.observed_ts IS NULL, ev.run_crossings DESC, ev.off_route_share, ev.observed_gap_s NULLS LAST,
           ev.vehicle_id, ev.run_id) = 1;

-- ---------------------------------------------------------------------------
-- 7. Quality
-- ---------------------------------------------------------------------------

-- qa_vp_stop_coverage: one row per system_key and service_date. Counts the
-- scheduled stop times of trips that appear in vehicle positions, and why
-- those without an observed pass (observed_ts) have none. A reason is read
-- from the trip's run with the most matched reports.
--   no_run              the trip's reports never formed a matched run (no
--                       pattern, or no report within reach of the line)
--   stop_not_placed     the stop has no coordinates
--   trace_started_past  the first matched report was already past the stop:
--                       the trip was picked up late, usually at the first stop
--   trace_ended_before  the last matched report had not reached it: the
--                       vehicle dropped the trip early, usually at the last stop
--   long_gap            the reports either side were more than 300 s apart
CREATE OR REPLACE TABLE qa_vp_stop_coverage AS
WITH seen AS (
  SELECT DISTINCT system_key, service_date, trip_id
  FROM stg_vehicle_position WHERE trip_id IS NOT NULL
),
main_run AS (
  SELECT system_key, service_date, trip_id, arg_max(run_id, (n_points, -run_id)) AS run_id
  FROM int_vp_run GROUP BY ALL
),
stop AS (
  SELECT st.system_key, st.service_date, st.trip_id, st.stop_sequence, st.is_first_stop, st.is_last_stop,
         e.observed_ts IS NOT NULL AS has_pass,
         e.trip_id IS NOT NULL AS has_event,
         CASE
           WHEN e.observed_ts IS NOT NULL THEN NULL
           WHEN m.run_id IS NULL THEN 'no_run'
           WHEN c.run_id IS NULL THEN 'stop_not_placed'
           ELSE coalesce(c.miss_reason, 'other')
         END AS miss_reason
  FROM fct_scheduled_stop_time st
  JOIN seen USING (system_key, service_date, trip_id)
  LEFT JOIN fct_stop_event_vp e USING (system_key, service_date, trip_id, stop_sequence)
  LEFT JOIN main_run m USING (system_key, service_date, trip_id)
  LEFT JOIN int_vp_stop_crossing c ON c.run_id = m.run_id AND c.stop_index = st.stop_index
)
SELECT system_key, service_date,
       count(DISTINCT trip_id) AS trips_seen,
       count(*) AS stop_times,
       count(*) FILTER (WHERE has_event) AS with_event,
       count(*) FILTER (WHERE has_pass) AS with_pass,
       count(*) FILTER (WHERE has_pass) / count(*) AS pass_share,
       count(*) FILTER (WHERE miss_reason = 'no_run') AS miss_no_run,
       count(*) FILTER (WHERE miss_reason = 'stop_not_placed') AS miss_stop_not_placed,
       count(*) FILTER (WHERE miss_reason = 'trace_started_past') AS miss_started_past,
       count(*) FILTER (WHERE miss_reason = 'trace_started_past' AND is_first_stop) AS miss_started_past_first_stop,
       count(*) FILTER (WHERE miss_reason = 'trace_ended_before') AS miss_ended_before,
       count(*) FILTER (WHERE miss_reason = 'trace_ended_before' AND is_last_stop) AS miss_ended_before_last_stop,
       count(*) FILTER (WHERE miss_reason = 'long_gap') AS miss_long_gap,
       count(*) FILTER (WHERE miss_reason = 'other') AS miss_other
FROM stop
GROUP BY ALL;

-- qa_vp_match: one row per system_key and service_date: how well reports fit
-- their lines, and how often the simplified rules above came into play.
--   reports_unmatched_trip  reports with a trip_id not scheduled that day (or
--                           with no usable pattern), so never matched
--   runs_multi_start        runs whose first report fit several passes of the
--                           line, so whole traces were compared
--   runs_start_by_schedule  of those, runs where the schedule settled a tie
--   events_multi_run        events where more than one run observed the stop
--   events_bracket_jump     events whose bracketing step fails [T5]
CREATE OR REPLACE TABLE qa_vp_match AS
WITH rep AS (
  SELECT v.system_key, v.service_date,
         count(*) AS reports_with_trip,
         count(*) FILTER (WHERE r.run_id IS NULL) AS reports_unmatched_trip
  FROM stg_vehicle_position v
  LEFT JOIN int_vp_report r
    ON r.system_key = v.system_key AND r.service_date = v.service_date AND r.trip_id = v.trip_id
   AND r.vehicle_id = v.vehicle_id AND r.position_ts = v.position_ts
  JOIN dim_service_day d ON d.system_key = v.system_key AND d.service_date = v.service_date
  WHERE v.trip_id IS NOT NULL
  GROUP BY ALL
),
starts AS (
  SELECT run_id, count(DISTINCT start_pass) AS n_starts FROM int_vp_trace_try GROUP BY ALL
),
runs AS (
  SELECT u.system_key, u.service_date,
         count(*) AS runs,
         sum(u.n_reports) AS run_reports,
         sum(u.n_off_route) AS run_reports_off_route,
         sum(u.n_backward) AS run_reports_backward,
         avg(u.progress_share) AS avg_progress_share,
         count(*) FILTER (WHERE s.n_starts > 1) AS runs_multi_start,
         count(*) FILTER (WHERE u.n_start_passes_tied > 1) AS runs_start_by_schedule
  FROM int_vp_run u JOIN starts s USING (run_id)
  GROUP BY ALL
),
ev AS (
  SELECT system_key, service_date, count(*) AS events,
         count(*) FILTER (WHERE n_runs_with_event > 1) AS events_multi_run,
         count(*) FILTER (WHERE bracket_gap_s > 120) AS events_bracket_over_120s,
         count(*) FILTER (WHERE is_bracket_jump) AS events_bracket_jump
  FROM fct_stop_event_vp GROUP BY ALL
)
SELECT *
FROM rep
LEFT JOIN runs USING (system_key, service_date)
LEFT JOIN ev USING (system_key, service_date);
