//! Map-matching: turning GPS fixes into progress along a route line.
//!
//! Each fix is projected onto the pattern's line inside a window that moves
//! forward with the vehicle, which keeps the match on the correct pass of a loop
//! or out-and-back shape. Progress then only ever goes forward.

use crate::geo::{Polyline, Projection, chord_m};

/// The rules applied before an interval counts toward speed. The tags match the
/// thresholds documented in the CTA scorecard and `docs/metrics.md`.
#[derive(Clone, Copy, Debug)]
pub struct TraceRules {
    /// Fixes farther than this from the line are treated as off-route.
    pub max_offset_m: f32,
    /// \[T1\] Layover trim: measure from the first fix this far past the start
    /// of the trace, up to the first fix this close to its furthest point.
    pub layover_trim_m: f32,
    /// \[T2\] A run of pairs moving no more than `standstill_move_m` that lasts at
    /// least `standstill_s` is a hold or a parked bus, not traffic.
    pub standstill_move_m: f32,
    pub standstill_s: f32,
    /// \[T3\] Do not bridge reporting gaps longer than this.
    pub max_gap_s: f32,
    /// \[T5\] Along-line progress must be supported by GPS movement.
    pub geometry_factor: f32,
    pub geometry_slack_m: f32,
    /// \[T6\] Absolute speed backstop.
    pub max_speed_mps: f32,
    /// Intervals below this speed count as time standing still.
    pub stopped_mps: f32,
}

impl TraceRules {
    /// Thresholds for road and rail modes. `max_speed_mps` is the only rule that
    /// differs: 80 mph for street modes and 150 mph for rail.
    pub fn for_route_type(route_type: Option<i32>) -> Self {
        let rail = matches!(
            crate::mode::Mode::from_route_type(route_type),
            crate::mode::Mode::Rail | crate::mode::Mode::Ferry
        );
        Self {
            max_offset_m: 120.0,
            layover_trim_m: 152.4,
            standstill_move_m: 30.48,
            standstill_s: 600.0,
            max_gap_s: 180.0,
            geometry_factor: 2.0,
            geometry_slack_m: 457.2,
            max_speed_mps: if rail { 67.0 } else { 35.8 },
            stopped_mps: 0.9,
        }
    }
}

/// One time-ordered position along the line. `s` never decreases.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TracePoint {
    pub t: i64,
    pub s: f32,
    pub lat: f32,
    pub lon: f32,
}

#[derive(Clone, Debug, Default)]
pub struct Trace {
    pub points: Vec<TracePoint>,
    pub off_route: u32,
    pub backward: u32,
}

/// How much worse an earlier pass of a loop can fit a fix and still be preferred.
const EARLIER_PASS_SLACK_M: f32 = 25.0;
/// Two traces progressing within this distance are equally good explanations.
const PROGRESS_TIE_M: f32 = 50.0;

/// Fixes must already be sorted by time and unique per time.
///
/// A line can pass the first fix's position more than once, on a loop or an
/// out-and-back. Each pass is tried in full, and the one that best explains the whole
/// run wins. Choosing by the schedule alone would send a late vehicle to the wrong
/// pass, which would lose the worst trips and flatter on-time performance. `expected_s`
/// estimates progress from the schedule and only settles real ties.
pub fn match_fixes(
    line: &Polyline,
    fixes: &[(i64, f32, f32)],
    rules: &TraceRules,
    expected_s: impl Fn(i64) -> Option<f32>,
) -> Trace {
    for (index, &(t, lat, lon)) in fixes.iter().enumerate() {
        let point = line.frame.to_xy(f64::from(lat), f64::from(lon));
        let passes: Vec<Projection> = line
            .candidates(point, rules.max_offset_m)
            .into_iter()
            .filter(|pass| pass.offset <= rules.max_offset_m)
            .collect();
        if passes.is_empty() {
            continue;
        }
        let expected = expected_s(t);
        let settled_by_schedule =
            |pass: Projection| expected.map_or(pass.s, |s| (pass.s - s).abs());
        let mut best: Option<(Trace, Projection)> = None;
        for pass in passes {
            let candidate = follow_from(line, &fixes[index..], pass, rules);
            let better = best.as_ref().is_none_or(|(current, current_pass)| {
                match candidate.off_route.cmp(&current.off_route) {
                    std::cmp::Ordering::Less => true,
                    std::cmp::Ordering::Greater => false,
                    std::cmp::Ordering::Equal => {
                        let gained = progress(&candidate) - progress(current);
                        if gained.abs() > PROGRESS_TIE_M {
                            gained > 0.0
                        } else {
                            settled_by_schedule(pass) < settled_by_schedule(*current_pass)
                        }
                    }
                }
            });
            if better {
                best = Some((candidate, pass));
            }
        }
        if let Some((mut trace, _)) = best {
            trace.off_route += index as u32;
            return trace;
        }
    }
    Trace {
        off_route: fixes.len() as u32,
        ..Trace::default()
    }
}

fn progress(trace: &Trace) -> f32 {
    match (trace.points.first(), trace.points.last()) {
        (Some(first), Some(last)) => last.s - first.s,
        _ => 0.0,
    }
}

/// Walks the fixes forward from a known position on the line. The first fix is the
/// one `start` was projected from.
fn follow_from(
    line: &Polyline,
    fixes: &[(i64, f32, f32)],
    start: Projection,
    rules: &TraceRules,
) -> Trace {
    let mut trace = Trace::default();
    let &(t0, lat0, lon0) = &fixes[0];
    trace.points.push(TracePoint {
        t: t0,
        s: start.s,
        lat: lat0,
        lon: lon0,
    });
    let mut previous = (t0, start.s);
    for &(t, lat, lon) in &fixes[1..] {
        // A frozen GPS unit can repeat an old fix. Time must also move forward.
        if t < previous.0 {
            continue;
        }
        let point = line.frame.to_xy(f64::from(lat), f64::from(lon));
        let elapsed = (t - previous.0) as f32;
        let reach = rules.max_speed_mps * elapsed + 200.0;
        let found = line
            .earliest_pass_in_window(
                point,
                previous.1 - 60.0,
                previous.1 + reach,
                EARLIER_PASS_SLACK_M,
            )
            .filter(|fit| fit.offset <= rules.max_offset_m);
        let Some(found) = found else {
            trace.off_route += 1;
            continue;
        };
        if found.s < previous.1 - 30.0 {
            trace.backward += 1;
        }
        let s = found.s.max(previous.1);
        trace.points.push(TracePoint { t, s, lat, lon });
        previous = (t, s);
    }
    trace
}

/// One interval that passed every rule.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Interval {
    pub t0: i64,
    pub t1: i64,
    pub s0: f32,
    pub s1: f32,
}

impl Interval {
    pub fn seconds(&self) -> f32 {
        (self.t1 - self.t0) as f32
    }
    pub fn meters(&self) -> f32 {
        self.s1 - self.s0
    }
}

/// Why intervals were dropped, for the quality funnel. Reasons overlap in the
/// source data, so each is counted at the first rule that removed it.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct IntervalCounts {
    pub pairs: u32,
    pub layover: u32,
    pub long_gap: u32,
    pub geometry: u32,
    pub too_fast: u32,
    pub standstill: u32,
    pub kept: u32,
    pub layover_s: f32,
    pub standstill_s: f32,
}

/// Applies \[T1\]–\[T6\] and returns the intervals that count toward speed.
pub fn intervals(trace: &Trace, rules: &TraceRules, counts: &mut IntervalCounts) -> Vec<Interval> {
    let points = &trace.points;
    if points.len() < 2 {
        return Vec::new();
    }
    let first_s = points[0].s;
    let last_s = points[points.len() - 1].s;
    // [T1] Layover trim. A trace that never leaves the trim zone keeps nothing.
    let start = points
        .iter()
        .position(|p| p.s > first_s + rules.layover_trim_m);
    let end = points
        .iter()
        .position(|p| p.s >= last_s - rules.layover_trim_m);
    let (Some(start), Some(end)) = (start, end) else {
        counts.pairs += points.len() as u32 - 1;
        counts.layover += points.len() as u32 - 1;
        return Vec::new();
    };
    // Include the pair crossing out of the start zone so distance isn't lost.
    let start = start.saturating_sub(1);

    let mut kept: Vec<Interval> = Vec::with_capacity(end.saturating_sub(start));
    for (index, pair) in points.windows(2).enumerate() {
        counts.pairs += 1;
        let (a, b) = (pair[0], pair[1]);
        let seconds = (b.t - a.t) as f32;
        if index < start || index >= end {
            counts.layover += 1;
            counts.layover_s += seconds;
            continue;
        }
        if seconds <= 0.0 {
            continue;
        }
        if seconds > rules.max_gap_s {
            counts.long_gap += 1;
            continue;
        }
        let meters = b.s - a.s;
        let crow = chord_m(
            f64::from(a.lat),
            f64::from(a.lon),
            f64::from(b.lat),
            f64::from(b.lon),
        ) as f32;
        if meters > rules.geometry_factor * crow + rules.geometry_slack_m {
            counts.geometry += 1;
            continue;
        }
        if meters / seconds > rules.max_speed_mps {
            counts.too_fast += 1;
            continue;
        }
        kept.push(Interval {
            t0: a.t,
            t1: b.t,
            s0: a.s,
            s1: b.s,
        });
    }
    remove_standstills(kept, rules, counts)
}

/// \[T2\] Drops runs of near-stationary pairs long enough to be a hold. Ordinary
/// stop and signal time stays in the measurement.
fn remove_standstills(
    kept: Vec<Interval>,
    rules: &TraceRules,
    counts: &mut IntervalCounts,
) -> Vec<Interval> {
    let mut output = Vec::with_capacity(kept.len());
    let mut run: Vec<Interval> = Vec::new();
    let mut run_seconds = 0.0_f32;
    let flush = |run: &mut Vec<Interval>,
                 run_seconds: &mut f32,
                 output: &mut Vec<Interval>,
                 counts: &mut IntervalCounts| {
        if *run_seconds >= rules.standstill_s {
            counts.standstill += run.len() as u32;
            counts.standstill_s += *run_seconds;
        } else {
            output.append(run);
        }
        run.clear();
        *run_seconds = 0.0;
    };
    for interval in kept {
        if interval.meters() <= rules.standstill_move_m {
            run_seconds += interval.seconds();
            run.push(interval);
        } else {
            flush(&mut run, &mut run_seconds, &mut output, counts);
            output.push(interval);
        }
    }
    flush(&mut run, &mut run_seconds, &mut output, counts);
    counts.kept += output.len() as u32;
    output
}

/// The first time the trace reaches `target`, interpolated between fixes.
/// `None` when the trace starts past the target, never reaches it, or when the
/// bracketing fixes are further apart than `max_gap_s`.
pub fn crossing_time(points: &[TracePoint], target: f32, max_gap_s: f32) -> Option<f64> {
    let index = points.partition_point(|p| p.s < target);
    let after = points.get(index)?;
    if index == 0 {
        return None;
    }
    let before = points[index - 1];
    let elapsed = (after.t - before.t) as f32;
    if elapsed > max_gap_s {
        return None;
    }
    let span = after.s - before.s;
    let fraction = if span > 0.0 {
        (target - before.s) / span
    } else {
        0.0
    };
    Some(before.t as f64 + f64::from(fraction) * f64::from(elapsed))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rules() -> TraceRules {
        TraceRules::for_route_type(Some(3))
    }

    /// About 4.4 km due north.
    fn line() -> Polyline {
        Polyline::from_lat_lon(&[(43.0, -89.0), (43.04, -89.0)]).unwrap()
    }

    fn point(t: i64, s: f32) -> TracePoint {
        TracePoint {
            t,
            s,
            lat: 43.0 + s / 111_320.0,
            lon: -89.0,
        }
    }

    #[test]
    fn matching_tracks_steady_progress_along_the_line() {
        let line = line();
        let fixes: Vec<(i64, f32, f32)> = (0..20)
            .map(|i| (i * 20, 43.0 + 0.001 * i as f32, -89.0))
            .collect();
        let trace = match_fixes(&line, &fixes, &rules(), |_| None);
        assert_eq!(trace.points.len(), 20);
        assert!(trace.points.windows(2).all(|w| w[1].s > w[0].s));
        assert!((trace.points[19].s - 19.0 * 111.32).abs() < 3.0);
    }

    #[test]
    fn gps_jitter_cannot_move_a_vehicle_backward() {
        let line = line();
        let fixes = [
            (0, 43.0100, -89.0),
            (20, 43.0095, -89.0),
            (40, 43.0120, -89.0),
        ];
        let trace = match_fixes(&line, &fixes, &rules(), |_| None);
        assert!(trace.points[1].s >= trace.points[0].s);
        assert_eq!(trace.backward, 1);
    }

    #[test]
    fn fixes_far_from_the_line_count_as_off_route() {
        let line = line();
        let fixes = [(0, 43.01, -89.0), (20, 43.012, -88.98), (40, 43.014, -89.0)];
        let trace = match_fixes(&line, &fixes, &rules(), |_| None);
        assert_eq!(trace.off_route, 1);
        assert_eq!(trace.points.len(), 2);
    }

    #[test]
    fn on_an_out_and_back_line_the_schedule_hint_picks_the_right_first_pass() {
        let line = Polyline::from_lat_lon(&[(43.0, -89.0), (43.02, -89.0), (43.0, -89.0)]).unwrap();
        let fixes = [(0, 43.005, -89.0)];
        let early = match_fixes(&line, &fixes, &rules(), |_| Some(500.0));
        let late = match_fixes(&line, &fixes, &rules(), |_| Some(3900.0));
        assert!(early.points[0].s < 1000.0);
        assert!(late.points[0].s > 3000.0);
    }

    #[test]
    fn a_late_vehicle_on_a_loop_starts_at_the_beginning_not_the_end() {
        // A closed loop: start and end are the same place. The vehicle is so late that
        // the schedule expects it near the end of the line while it is at the start.
        let line = Polyline::from_lat_lon(&[
            (43.0, -89.0),
            (43.02, -89.0),
            (43.02, -88.97),
            (43.0, -88.97),
            (43.0, -89.0),
        ])
        .unwrap();
        let fixes: Vec<(i64, f32, f32)> = (0..30)
            .map(|i| (i64::from(i) * 20, 43.0 + 0.0005 * i as f32, -89.0))
            .collect();
        let trace = match_fixes(&line, &fixes, &rules(), |_| Some(line.length() * 0.9));
        assert_eq!(trace.off_route, 0, "every fix fits when started correctly");
        assert_eq!(trace.points.len(), 30);
        assert!(trace.points[0].s < 100.0, "{}", trace.points[0].s);
        assert!(trace.points[29].s > 1000.0, "{}", trace.points[29].s);
    }

    #[test]
    fn with_nothing_else_to_go_on_the_schedule_settles_which_pass() {
        let line = Polyline::from_lat_lon(&[(43.0, -89.0), (43.02, -89.0), (43.0, -89.0)]).unwrap();
        let fixes = [(0, 43.005, -89.0)];
        let early = match_fixes(&line, &fixes, &rules(), |_| Some(0.0));
        let late = match_fixes(&line, &fixes, &rules(), |_| Some(line.length()));
        assert!(early.points[0].s < line.length() / 2.0);
        assert!(late.points[0].s > line.length() / 2.0);
    }

    #[test]
    fn a_vehicle_returning_along_the_same_street_follows_the_return_leg() {
        // An out-and-back along one street, reporting every 20 seconds.
        let line = Polyline::from_lat_lon(&[(43.0, -89.0), (43.02, -89.0), (43.0, -89.0)]).unwrap();
        let mut fixes: Vec<(i64, f32, f32)> = Vec::new();
        for i in 0..=40 {
            let lat = if i <= 20 {
                43.0 + 0.001 * i as f32
            } else {
                43.04 - 0.001 * i as f32
            };
            fixes.push((i64::from(i) * 20, lat, -89.0));
        }
        let trace = match_fixes(&line, &fixes, &rules(), |_| None);
        assert_eq!(trace.off_route, 0);
        let last = trace.points.last().unwrap().s;
        assert!(last > line.length() * 0.95, "{last} of {}", line.length());
    }

    #[test]
    fn the_layover_at_each_end_is_excluded_from_measured_time() {
        let trace = Trace {
            points: vec![
                point(0, 0.0),
                point(300, 5.0),   // sitting at the terminal
                point(320, 200.0), // leaves the trim zone
                point(340, 400.0),
                point(360, 600.0),
                point(380, 790.0), // reaches the end zone
                point(900, 795.0), // layover at the far terminal
            ],
            ..Trace::default()
        };
        let mut counts = IntervalCounts::default();
        let kept = intervals(&trace, &rules(), &mut counts);
        assert_eq!(
            kept.first().unwrap().t0,
            300,
            "keeps the pair leaving the zone"
        );
        assert_eq!(kept.last().unwrap().t1, 380);
        assert_eq!(counts.layover, 2);
        assert_eq!(counts.layover_s, 300.0 + 520.0);
    }

    #[test]
    fn reporting_gaps_and_impossible_speeds_are_dropped() {
        let trace = Trace {
            points: vec![
                point(0, 0.0),
                point(20, 200.0),
                point(40, 400.0),
                point(400, 900.0), // 360 s gap
                point(420, 1100.0),
                point(421, 1400.0), // 300 m/s
                point(440, 1600.0),
                point(460, 1800.0),
                point(480, 2000.0),
            ],
            ..Trace::default()
        };
        let mut counts = IntervalCounts::default();
        let kept = intervals(&trace, &rules(), &mut counts);
        assert_eq!(counts.long_gap, 1);
        assert_eq!(counts.too_fast, 1);
        assert!(
            kept.iter()
                .all(|i| i.seconds() <= 180.0 && i.meters() / i.seconds() < 36.0)
        );
    }

    #[test]
    fn long_holds_are_removed_but_ordinary_stops_stay() {
        let mut points = vec![point(0, 0.0), point(20, 200.0)];
        // A signal: 60 s standing still counts as ordinary delay.
        points.push(point(80, 205.0));
        points.push(point(100, 400.0));
        // A 15 minute hold is not traffic.
        for i in 1..=45 {
            points.push(point(100 + i * 20, 400.0 + i as f32 * 0.1));
        }
        points.push(point(1020, 600.0));
        points.push(point(1040, 900.0));
        let trace = Trace {
            points,
            ..Trace::default()
        };
        let mut counts = IntervalCounts::default();
        let kept = intervals(&trace, &rules(), &mut counts);
        assert!(
            kept.iter().any(|i| i.t0 == 20 && i.t1 == 80),
            "signal time stays"
        );
        assert_eq!(counts.standstill, 45);
        assert!(!kept.iter().any(|i| i.t0 == 500));
    }

    #[test]
    fn crossing_time_interpolates_and_refuses_to_guess() {
        let points = vec![point(0, 0.0), point(20, 100.0), point(400, 500.0)];
        assert_eq!(crossing_time(&points, 50.0, 180.0), Some(10.0));
        assert_eq!(crossing_time(&points, 0.0, 180.0), None, "already past it");
        assert_eq!(crossing_time(&points, 300.0, 180.0), None, "gap too long");
        assert_eq!(crossing_time(&points, 900.0, 180.0), None, "never reached");
    }
}
