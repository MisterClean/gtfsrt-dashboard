// What the Rust reports return. Mirrors crates/core/src/report.rs.
export type Mode = 'All' | 'Bus' | 'Rail' | 'Ferry' | 'Other' | 'Unknown';
export type DayStatus = 'Complete' | 'Partial' | 'NoData';

export interface OnTime { total: number; early: number; on_time: number; late: number }

export interface HeadwayStats {
  count: number;
  bunched: number;
  gapped: number;
  wait_ok: number;
  actual_wait_s: number | null;
  scheduled_wait_s: number | null;
  excess_wait_s: number | null;
}

export interface HourRow {
  hour: number;
  speed: number | null;
  scheduled_speed: number | null;
  on_time: OnTime;
  trips_scheduled: number;
  trips_observed: number;
  service_hours_scheduled: number;
  service_hours_observed: number;
  vehicles: number;
  stopped_share: number | null;
  headways: HeadwayStats | null;
}

export interface DayRow {
  date: string;
  weekday: number;
  speed: number | null;
  peak_speed: number | null;
  on_time: OnTime;
  trips_scheduled: number;
  trips_observed: number;
  empty_buckets: number;
  service_buckets: number;
  status: DayStatus;
  warnings: string[];
}

export interface Overview {
  dates: string[];
  speed: number | null;
  scheduled_speed: number | null;
  speed_am: number | null;
  speed_mid: number | null;
  speed_pm: number | null;
  speed_peak: number | null;
  on_time: OnTime;
  mean_deviation_s: number | null;
  deviation_bins: number[];
  deviation_edges: number[];
  trips_scheduled_per_day: number;
  trips_observed_per_day: number;
  service_hours_scheduled_per_day: number;
  service_hours_observed_per_day: number;
  distance_km_per_day: number;
  peak_vehicles: number;
  stopped_share: number | null;
  headways: HeadwayStats | null;
  hourly: HourRow[];
  days: DayRow[];
  route_count: number;
}

export interface Stretch {
  dir: number;
  from: string;
  to: string;
  speed: number;
  length_m: number;
  s0: number;
  s1: number;
}

export interface RouteScore {
  id: string;
  label: string;
  long_name: string;
  mode: Mode;
  color: string;
  text_color: string;
  trips_scheduled: number;
  trips_observed: number;
  service_hours_per_day: number;
  speed: number | null;
  speed_am: number | null;
  speed_mid: number | null;
  speed_pm: number | null;
  speed_peak: number | null;
  scheduled_speed: number | null;
  fixed_coverage: number | null;
  peak_change: number | null;
  peak_ci: [number, number] | null;
  peak_change_ci: [number, number] | null;
  on_time: OnTime;
  mean_deviation_s: number | null;
  headways: HeadwayStats | null;
  run_p50_s: number | null;
  run_p90_s: number | null;
  run_scheduled_s: number | null;
  stopped_share: number | null;
  peak_vehicles: number;
  hourly: (number | null)[];
  slowest: Stretch | null;
  stops_per_km: number | null;
  mean_stop_spacing_m: number | null;
  close_stop_share: number | null;
  occupancy: number[];
}

export interface MapFeature {
  id: number;
  path: [number, number][];
  length_m: number;
  routes: string[];
  speeds: (number | null)[];
  all_day: number | null;
  am: number | null;
  mid: number | null;
  pm: number | null;
  measurements: number;
  bus_hours_per_day: number;
}

export interface MapHour { hour: number; speed: number | null; cells: number; slow_share: number | null }

export interface NetworkMap {
  center: [number, number];
  features: MapFeature[];
  hours: MapHour[];
  bounds: [number, number, number, number] | null;
}

export interface Hotspot {
  rank: number;
  from: string;
  to: string;
  routes: string[];
  length_m: number;
  delay_hours_per_day: number;
  bus_hours_per_day: number;
  reference_speed: number;
  worst_speed: number;
  worst_hour: number;
  peak_speed: number | null;
  stopped_share: number | null;
  path: [number, number][];
  hourly: (number | null)[];
}

export interface HotspotReport {
  delay_hours_per_day: number;
  bus_hours_per_day: number;
  hotspots: Hotspot[];
}

export interface ProfileBin { s0: number; s1: number; speeds: (number | null)[]; measurements: number }

export interface RouteStop {
  id: string;
  name: string;
  lat: number;
  lon: number;
  s: number;
  passes: number;
  scheduled: number;
  zone_seconds: number | null;
  deviation_by_period: (number | null)[];
  deviation: number | null;
  on_time: OnTime;
  headways: HeadwayStats | null;
  gap_to_next_m: number | null;
}

export interface RunTimeRow { hour: number; count: number; p10: number; p50: number; p90: number; scheduled: number }

export interface DirectionHour {
  hour: number;
  speed: number | null;
  scheduled_speed: number | null;
  on_time: OnTime;
  trips_scheduled: number;
  trips_observed: number;
  headways: HeadwayStats | null;
  actual_headway_s: number | null;
  scheduled_headway_s: number | null;
}

export interface PatternSummary {
  index: number;
  headsign: string;
  stops: number;
  length_m: number;
  trips_observed: number;
  trips_scheduled: number;
}

export interface DirectionDetail {
  dir: number;
  headsign: string;
  pattern: number;
  patterns: PatternSummary[];
  length_m: number;
  path: [number, number][];
  profile: ProfileBin[];
  stops: RouteStop[];
  hourly: DirectionHour[];
  run_times: RunTimeRow[];
  slowest: Stretch | null;
  stop_gaps_m: number[];
  stops_per_km: number | null;
  mean_stop_spacing_m: number | null;
  close_stop_share: number | null;
}

export interface RouteDetail { score: RouteScore; directions: DirectionDetail[]; dates: string[] }

export interface StringLineTrip {
  trip_id: string;
  vehicle: string;
  deviation_end_s: number | null;
  observed: [number, number][];
  scheduled: [number, number][];
}

export interface StringLineResult {
  /** Stop events exist on this device for the day. Without them there is no chart. */
  available: boolean;
  line: StringLine | null;
}

export interface StringLine {
  date: string;
  route: string;
  dir: number;
  length_m: number;
  stops: [number, string][];
  trips: StringLineTrip[];
}

export interface StopRow {
  id: string;
  code: string;
  name: string;
  lat: number;
  lon: number;
  routes: string[];
  passes_per_day: number;
  scheduled_per_day: number;
  zone_seconds: number | null;
  zone_hours_per_day: number;
  mean_deviation_s: number | null;
  on_time: OnTime;
  nearest_stop_m: number | null;
}

export interface RouteSpacing {
  route: string;
  label: string;
  dir: number;
  headsign: string;
  stops: number;
  mean_m: number;
  median_m: number;
  per_km: number;
  close_share: number;
  zone_share: number | null;
}

export interface StopsReport {
  stops: StopRow[];
  spacing: RouteSpacing[];
  spacing_histogram: number[];
  spacing_bin_m: number;
  close_threshold_m: number;
}

export interface Quality {
  rows: number;
  no_trip: number;
  no_vehicle: number;
  bad_coordinate: number;
  fallback_time: number;
  differential: number;
  fixes_unique: number;
  fixes_trip_unmatched: number;
  fixes_on_day: number;
  fixes_no_service_date: number;
  off_route: number;
  backward: number;
  trips_scheduled: number;
  trips_observed: number;
  trips_complete: number;
  pairs: number;
  pairs_layover: number;
  pairs_long_gap: number;
  pairs_geometry: number;
  pairs_too_fast: number;
  pairs_standstill: number;
  pairs_no_route: number;
  pairs_kept: number;
  seconds_layover: number;
  seconds_standstill: number;
  seconds_kept: number;
  meters_kept: number;
  stops_expected: number;
  stops_observed: number;
  polls: number[];
  service_buckets: number;
  empty_buckets: number;
}

export interface QualityDay { date: string; digest: string; status: DayStatus; quality: Quality; warnings: string[] }
export interface QualityReport { days: QualityDay[]; metric_version: number }

// ---- Catalog and engine messages -------------------------------------------

export interface Feed {
  base64url: string;
  agency_id: string | null;
  agency_name: string | null;
  system_id: string | null;
  system_name: string | null;
  feed_type: string;
  date_min: string;
  date_max: string;
  total_records: number;
  total_bytes: number;
}

export interface Selection {
  dates: number[];
  mode: Mode;
  early_s: number;
  late_s: number;
  periods: { am: [number, number]; mid: [number, number]; pm: [number, number] };
}

export interface AnalyzeRequest {
  /** Tags this run's events, so nothing from an earlier run can be mistaken for it. */
  run: number;
  feedKey: string;
  dates: number[];
  dateMax: string;
}

export interface ReadRecord {
  date: string;
  url: string;
  bytes: number;
  status: 'read' | 'missing';
  rows: number;
  seconds: number;
  sql: string;
}

export interface ScheduleRecord {
  key: string;
  bases: string[];
  retrieved: string[];
  published_before: boolean;
  timezone: string | null;
  warnings: string[];
}

export type EngineEvent =
  | {
      event: 'stage'; message: string; fraction: number; dayIndex: number; dayCount: number;
      /** Which part of a run this is, for the explanation under the progress bar. */
      phase?: 'database' | 'lookup' | 'read' | 'schedule' | 'analyze';
      /** Archive file bytes scanned so far, by file size and position, and the total. Not network bytes. */
      bytesDone?: number; bytesTotal?: number;
      /** The service day being analyzed, when there is one. */
      date?: number;
    }
  | { event: 'day'; date: number; cached: boolean }
  | { event: 'unavailable'; date: number; reason: string }
  | { event: 'read'; record: ReadRecord }
  | { event: 'schedule'; record: ScheduleRecord }
  | { event: 'warning'; message: string }
  /** The browser can't keep results. Sent once per session, not tied to a run. */
  | { event: 'cache'; message: string };

export interface CachedDays { dates: number[]; bytes: number }

export interface AnalyzeResult {
  analyzed: number[];
  cached: number[];
  unavailable: { date: number; reason: string }[];
  stopped: boolean;
  engineVersion: string | null;
}
