// The constants behind the numbers, for the provenance download. They mirror
// crates/core/src/{trace,day,report,schedule,cube}.rs and docs/metrics.md, and
// change only together with METRIC_VERSION.
export const THRESHOLDS = {
  map_matching: {max_offset_m: 120, window_back_m: 60, window_forward_slack_m: 200},
  speed_rules: {
    layover_trim_m: 152.4,
    standstill_move_m: 30.48,
    standstill_s: 600,
    max_gap_s: 180,
    geometry_factor: 2,
    geometry_slack_m: 457.2,
    max_speed_street_mps: 35.8,
    max_speed_rail_ferry_mps: 67,
    stopped_below_mps: 0.9,
  },
  trips: {run_break_s: 10800, date_search_limit_s: 14400, observed_coverage: 0.5, complete_coverage: 0.9},
  stops: {zone_half_width_m: 25, max_event_gap_s: 300, close_spacing_m: 244},
  headways: {frequent_at_or_below_s: 900, bunched_below_share: 0.25, gapped_above_share: 1.5, wait_allowance_s: 180, minimum_count: 10},
  segments: {cell_m: 200, sectors: 8, sliver_merge_m: 40, minimum_measurements: 'the larger of 2 and the number of days'},
  stretches: {window_m: 800, end_margin_m: 1609},
  hotspots: {reference_percentile: 0.85, minimum_hours: 3, extend_density_share: 0.35, maximum_length_m: 1500, listed: 40},
  intervals: {bootstrap_rounds: 1000, minimum_days: 5, level: 0.95},
} as const;
