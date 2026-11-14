-- Metric registry: the definition of every reported metric, in one table, so
-- a reader can see what a number means without reading the SQL, and a second
-- implementation can be checked against the same words.
--
-- meta_metric: one row per metric.
--   formula       in terms of mart columns
--   eligibility   which events or trips enter the denominator
--   missing_data  what happens when the feed says nothing
--   limits        how the number can mislead
CREATE OR REPLACE TABLE meta_metric (
  metric_key VARCHAR PRIMARY KEY,
  name VARCHAR,
  unit VARCHAR,
  source_table VARCHAR,
  formula VARCHAR,
  eligibility VARCHAR,
  missing_data VARCHAR,
  limits VARCHAR
);

INSERT INTO meta_metric VALUES
('feed_captured_share', 'Feed capture', 'share', 'mart_feed_day',
 '1 - gap_s / span_s',
 'The service span: first scheduled departure to last scheduled arrival of the service day, clipped to the slice.',
 'A gap is more than capture_gap_s with no capture that returned rows. A capture that failed and a feed that was empty leave the same trace and are both counted as gap.',
 'An overnight feed with no vehicles reads as a gap. Read it per feed type: a gap in positions while trip updates were captured points at the feed, not the archive.'),

('feed_freshness', 'Feed freshness', 'seconds', 'fct_feed_poll',
 'fetch_ts - feed header timestamp; reported as median and 95th percentile',
 'Captures inside the service span whose feed header carries a timestamp.',
 'Captures with no header timestamp are left out and counted (polls - polls_with_header_time).',
 'Measures the producer''s publishing delay plus the archive''s polling phase, not the age of each vehicle''s own report.'),

('stale_poll_share', 'Captures with no new feed version', 'share', 'mart_feed_day',
 'stale_polls / polls',
 'Captures inside the service span.',
 'A capture is stale when the feed header timestamp equals the previous capture''s.',
 'A feed that republishes every 60 s and is captured every 20 s is two-thirds stale by construction. Compare with poll_interval_s.'),

('operated_share', 'Trips operated', 'share', 'mart_trip_delivery',
 'operated / measurable_trips',
 'Scheduled trips, wholly inside the slice, with under 10% of their scheduled span inside capture gaps of each feed the system has, on routes where at least one scheduled trip was observed that day. Trips on routes the feeds do not report are counted in unreported_route_trips.',
 'A trip with stop events at under half its stops is partly_observed, not operated. A trip with no evidence is not_observed. Neither is counted as canceled.',
 'A trip that ran without reporting reads as not operated. The share is evidence of delivery, bounded above by the feed''s own coverage of its fleet.'),

('canceled_share', 'Trips canceled (published)', 'share', 'mart_trip_delivery',
 'canceled / measurable_trips',
 'Same trips as operated_share.',
 'Counts only cancellations the trip-updates feed published and still stood by at its last mention of the trip. Silent cancellations are in not_observed.',
 'Agencies differ widely in whether they publish cancellations at all, so this is a floor on cancellations and is not comparable between agencies.'),

('not_observed_share', 'Trips with no evidence', 'share', 'mart_trip_delivery',
 'not_observed / measurable_trips',
 'Same trips as operated_share.',
 'Scheduled, no stop event, no position report, no cancellation.',
 'Mixes unpublished cancellations with vehicles that ran without reporting and trips whose realtime trip_id did not match the schedule.'),

('on_time_share', 'On-time performance', 'share', 'mart_otp',
 'on_time / timed_events, where on_time is otp_early_s <= deviation_s < otp_late_s',
 'Scheduled stop times at timepoints (every stop when a trip marks none), inside the slice, on trips that are not frequency-based and not canceled, that have a stop event from vehicle positions. One event per trip per stop.',
 'A stop with no event is left out; it is not counted late. Read beside operated_share and the stop-event coverage in qa_stop_event_coverage.',
 'Stop events are inferred, from positions or from the feed''s own final times, never from door sensors. The method is in event_method and results by different methods are not interchangeable.'),

('tu_on_time_share', 'On-time performance, trip-update events', 'share', 'mart_otp',
 'on_time / timed_events over rows with event_method = trip_updates',
 'As on_time_share, but only stops with no vehicle-position event whose final trip-update time is graded observed.',
 'As on_time_share.',
 'A different population from on_time_share (mostly trip ends) timed by the feed''s own final word. Report beside on_time_share; do not pool or compare the two.'),

('early_share', 'Early share', 'share', 'mart_otp',
 'early / timed_events, where early is deviation_s < otp_early_s',
 'Same events as on_time_share.',
 'As on_time_share.',
 'At a trip''s first stop a vehicle repositioning during layover can read as an early departure.'),

('late_share', 'Late share', 'share', 'mart_otp',
 'late / timed_events, where late is deviation_s >= otp_late_s',
 'Same events as on_time_share.',
 'As on_time_share.',
 'As on_time_share.'),

('mean_deviation', 'Mean schedule deviation', 'seconds', 'mart_otp',
 'sum_deviation_s / timed_events',
 'Same events as on_time_share.',
 'As on_time_share.',
 'A mean hides spread; a route can average zero by being early and late.'),

('bunched_share', 'Bunched headways', 'share', 'mart_headway',
 'bunched / headways, where bunched is observed < headway_bunched_ratio x scheduled',
 'Valid observed headways at stops where the scheduled headway is frequent_headway_s or less; last stops, same-vehicle returns and mixed-method pairs excluded.',
 'A missing stop event lengthens the next headway. Gaps longer than both an hour and four scheduled headways are dropped as unobserved passes.',
 'Definitions of bunching vary between agencies; some use a fixed number of minutes.'),

('gap_share_at_least', 'Gapped headways (floor)', 'share', 'mart_headway',
 'gaps / headways, where a gap is observed > headway_gap_ratio x scheduled',
 'Same headways as bunched_share.',
 'Same as bunched_share.',
 'A floor: the longest gaps are the ones dropped as unobserved. A trip absent from the feed lengthens observed headways whether or not it ran.'),

('wait_assessment_share', 'Wait assessment', 'share', 'mart_headway',
 'within_3min / headways, where observed <= scheduled + 180 s',
 'Same headways as bunched_share.',
 'Same as bunched_share.',
 'A three-minute allowance at all hours; some agencies allow more off-peak.'),

('excess_wait', 'Excess wait', 'seconds', 'mart_headway',
 'sum_h2 / (2 x sum_h) - sum_sh2 / (2 x sum_sh)',
 'Same headways as bunched_share. Needs min_events_shown headways.',
 'Same as bunched_share.',
 'Assumes riders arrive at random and weights every stop equally; there is no ridership in the archive.'),

('prediction_accuracy', 'Prediction accuracy', 'share', 'mart_prediction',
 'accurate / predictions, where accurate is early_limit_s <= error_s <= late_limit_s for the horizon bucket in meta_prediction_window',
 'One capture per minute; arrival predictions for scheduled stops with a stop event, made 0 to 30 minutes before it, on trips not canceled.',
 'A prediction for a stop that never gets an event is not scored. Predictions the feed never made are not penalised here; see prediction coverage when added.',
 'Where truth_method is trip_updates the feed is scored against its own final word, which flatters short horizons. Not comparable with truth from vehicle positions.'),

('alert_seconds', 'Alert time on a route', 'seconds', 'fct_alert_route_day',
 'Seconds of the service span with at least one alert of that effect informing the route, carried by the feed and inside its active period; overlapping alerts merged.',
 'Alerts that inform a route directly or through one of its scheduled trips.',
 'Agency-wide and stop-only alerts are not attributed to routes.',
 'Agencies use alerts very differently; a standing detour notice and a live disruption look the same here.');
