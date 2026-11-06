//! Local-plane geometry: projecting GPS fixes onto route polylines.

use serde::{Deserialize, Serialize};

const METERS_PER_DEGREE: f64 = 111_320.0;

/// An equirectangular frame centred on one shape. Over the length of a transit
/// route the distortion is well under one percent.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct LocalFrame {
    pub lat0: f64,
    pub lon0: f64,
    pub cos_lat: f64,
}

impl LocalFrame {
    pub fn new(lat0: f64, lon0: f64) -> Self {
        Self {
            lat0,
            lon0,
            cos_lat: lat0.to_radians().cos().abs().max(0.01),
        }
    }

    pub fn to_xy(&self, lat: f64, lon: f64) -> [f32; 2] {
        [
            ((lon - self.lon0) * self.cos_lat * METERS_PER_DEGREE) as f32,
            ((lat - self.lat0) * METERS_PER_DEGREE) as f32,
        ]
    }

    pub fn to_lat_lon(&self, xy: [f32; 2]) -> (f64, f64) {
        (
            self.lat0 + f64::from(xy[1]) / METERS_PER_DEGREE,
            self.lon0 + f64::from(xy[0]) / (self.cos_lat * METERS_PER_DEGREE),
        )
    }
}

/// Straight-line distance between two GPS points, in meters.
pub fn chord_m(lat0: f64, lon0: f64, lat1: f64, lon1: f64) -> f64 {
    let k = ((lat0 + lat1) / 2.0).to_radians().cos();
    let dy = (lat1 - lat0) * METERS_PER_DEGREE;
    let dx = (lon1 - lon0) * k * METERS_PER_DEGREE;
    (dx * dx + dy * dy).sqrt()
}

pub fn valid_coordinate(lat: f64, lon: f64) -> bool {
    lat.is_finite()
        && lon.is_finite()
        && (-90.0..=90.0).contains(&lat)
        && (-180.0..=180.0).contains(&lon)
        && !(lat == 0.0 && lon == 0.0)
}

/// Longest segment on either side of a vertex that can be a stop spike.
const SPIKE_MAX_SEGMENT_M: f64 = 30.0;
/// How sharply the line must turn at a spike's tip.
const SPIKE_MIN_TURN_DEG: f64 = 75.0;
/// How far the road may change direction across a spike and still count as one road.
const SPIKE_MAX_ROAD_TURN_DEG: f64 = 45.0;

/// Removes the short detours some agencies draw from the road to each stop's curb.
///
/// A vehicle doesn't drive these, but their length adds up: in Madison they make speeds
/// read about 1.3% fast overall, and nearly 5% on routes with many stops. A spike
/// is a sharp turn between two short segments where the road carries on in the same
/// direction beyond it. That last test is what keeps real corners and U-turns, where
/// the road comes out heading somewhere else.
pub fn remove_spikes(points: &[(f64, f64)]) -> Vec<(f64, f64)> {
    let mut kept: Vec<(f64, f64)> = points.to_vec();
    loop {
        let mut removed = false;
        let mut index = 2;
        while index + 2 < kept.len() {
            if is_spike(
                kept[index - 2],
                kept[index - 1],
                kept[index],
                kept[index + 1],
                kept[index + 2],
            ) {
                kept.remove(index);
                removed = true;
            } else {
                index += 1;
            }
        }
        if !removed {
            return kept;
        }
    }
}

/// `tip` is the suspect vertex, between `a` and `b`. `before` and `after` show which
/// way the road runs on each side.
fn is_spike(
    before: (f64, f64),
    a: (f64, f64),
    tip: (f64, f64),
    b: (f64, f64),
    after: (f64, f64),
) -> bool {
    let local = |from: (f64, f64), to: (f64, f64)| {
        let k = ((from.0 + to.0) / 2.0).to_radians().cos();
        (
            (to.1 - from.1) * k * METERS_PER_DEGREE,
            (to.0 - from.0) * METERS_PER_DEGREE,
        )
    };
    let turn = |u: (f64, f64), v: (f64, f64)| {
        let cross = u.0 * v.1 - u.1 * v.0;
        let dot = u.0 * v.0 + u.1 * v.1;
        cross.atan2(dot).abs().to_degrees()
    };
    let length = |v: (f64, f64)| v.0.hypot(v.1);
    let (into_tip, out_of_tip) = (local(a, tip), local(tip, b));
    let (road_in, road_out) = (local(before, a), local(b, after));
    let short = |v: (f64, f64)| {
        let meters = length(v);
        meters > 0.0 && meters <= SPIKE_MAX_SEGMENT_M
    };
    short(into_tip)
        && short(out_of_tip)
        && length(road_in) > 0.0
        && length(road_out) > 0.0
        && turn(into_tip, out_of_tip) >= SPIKE_MIN_TURN_DEG
        && turn(road_in, road_out) <= SPIKE_MAX_ROAD_TURN_DEG
}

/// How far past the earliest fitting point still counts as the same pass of the line.
const SAME_PASS_SPAN_M: f32 = 150.0;
/// How much better a fit further along the line must be, in meters of fit per meter
/// along. Legs drawn exactly on top of each other differ only by rounding, and that
/// mustn't carry a vehicle hundreds of meters ahead, where it couldn't come back.
const LATER_FIT_COST: f32 = 0.01;
/// Cost per meter along the line when placing a stop, in meters of fit. Two passes can
/// fit a stop equally well, and the earlier one is then the likelier: about 2 m per km.
const LATER_PASS_COST: f32 = 0.002;

/// A point projected onto a polyline.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Projection {
    /// Distance along the line, in meters.
    pub s: f32,
    /// Perpendicular distance from the line, in meters.
    pub offset: f32,
}

/// A route line in local meters with cumulative distance at every vertex.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Polyline {
    pub frame: LocalFrame,
    pub xy: Vec<[f32; 2]>,
    pub cum: Vec<f32>,
}

impl Polyline {
    /// Builds from `(lat, lon)` points, dropping invalid and repeated vertices.
    /// Returns `None` when fewer than two usable points remain.
    pub fn from_lat_lon(points: &[(f64, f64)]) -> Option<Self> {
        let usable: Vec<(f64, f64)> = points
            .iter()
            .copied()
            .filter(|(lat, lon)| valid_coordinate(*lat, *lon))
            .collect();
        let count = usable.len();
        if count < 2 {
            return None;
        }
        let lat0 = usable.iter().map(|p| p.0).sum::<f64>() / count as f64;
        let lon0 = usable.iter().map(|p| p.1).sum::<f64>() / count as f64;
        let frame = LocalFrame::new(lat0, lon0);
        let mut xy: Vec<[f32; 2]> = Vec::with_capacity(count);
        let mut cum: Vec<f32> = Vec::with_capacity(count);
        for (lat, lon) in usable {
            let point = frame.to_xy(lat, lon);
            match xy.last() {
                None => {
                    xy.push(point);
                    cum.push(0.0);
                }
                Some(previous) => {
                    let step = distance(*previous, point);
                    if step > 0.01 {
                        let total = cum.last().copied().unwrap_or(0.0) + step;
                        xy.push(point);
                        cum.push(total);
                    }
                }
            }
        }
        (xy.len() >= 2).then_some(Self { frame, xy, cum })
    }

    pub fn length(&self) -> f32 {
        self.cum.last().copied().unwrap_or(0.0)
    }

    /// The closest point on the line within the along-line window `[s_lo, s_hi]`.
    pub fn nearest_in_window(&self, point: [f32; 2], s_lo: f32, s_hi: f32) -> Option<Projection> {
        let mut best: Option<Projection> = None;
        for segment in self.segments_between(s_lo, s_hi) {
            let candidate = self.project_on_segment(point, segment);
            let s = candidate.s.clamp(s_lo.max(0.0), s_hi.min(self.length()));
            let adjusted = if (s - candidate.s).abs() < 0.01 {
                candidate
            } else {
                Projection {
                    s,
                    offset: distance(point, self.point_at(s)),
                }
            };
            if best.is_none_or(|b| adjusted.offset < b.offset) {
                best = Some(adjusted);
            }
        }
        best
    }

    /// Where a fix sits within the along-line window `[s_lo, s_hi]`, preferring the
    /// earliest pass whose fit is within `slack` meters of the best fit.
    ///
    /// A window can span the return leg of a loop, and GPS noise can make that leg
    /// look a little closer. Taking it would be permanent, since progress only goes
    /// forward, so the earlier pass wins unless it's clearly worse.
    pub fn earliest_pass_in_window(
        &self,
        point: [f32; 2],
        s_lo: f32,
        s_hi: f32,
        slack: f32,
    ) -> Option<Projection> {
        let fit = |segment: usize| {
            let candidate = self.project_on_segment(point, segment);
            let s = candidate.s.clamp(s_lo.max(0.0), s_hi.min(self.length()));
            if (s - candidate.s).abs() < 0.01 {
                candidate
            } else {
                Projection {
                    s,
                    offset: distance(point, self.point_at(s)),
                }
            }
        };
        let range = self.segments_between(s_lo, s_hi);
        let best = range
            .clone()
            .map(|segment| fit(segment).offset)
            .min_by(f32::total_cmp)?;
        let limit = best + slack;
        let mut chosen: Option<Projection> = None;
        for segment in range {
            let candidate = fit(segment);
            if candidate.offset <= limit {
                if chosen.is_none_or(|c| fits_better_further_on(candidate, c)) {
                    chosen = Some(candidate);
                }
            } else if chosen.is_some() {
                break;
            }
        }
        let earliest = chosen?;
        // The hook at the end of a line can double back within a few meters. Without
        // this, progress stops short of the last stop and a later fix records the arrival.
        let ahead =
            self.nearest_in_window(point, earliest.s, (earliest.s + SAME_PASS_SPAN_M).min(s_hi));
        Some(match ahead {
            Some(better) if fits_better_further_on(better, earliest) => better,
            _ => earliest,
        })
    }

    /// Every local minimum of distance within `max_offset`, in along-line order.
    /// Shapes that double back pass a point more than once, and each pass is a
    /// separate candidate. Falls back to the single nearest point.
    pub fn candidates(&self, point: [f32; 2], max_offset: f32) -> Vec<Projection> {
        let mut found: Vec<Projection> = Vec::new();
        let mut nearest: Option<Projection> = None;
        let mut current: Option<Projection> = None;
        for segment in 0..self.xy.len().saturating_sub(1) {
            let candidate = self.project_on_segment(point, segment);
            if nearest.is_none_or(|n| candidate.offset < n.offset) {
                nearest = Some(candidate);
            }
            if candidate.offset <= max_offset {
                match current {
                    // Still within reach but far along the line: a second pass.
                    Some(best) if candidate.s - best.s > 2.0 * max_offset => {
                        found.push(best);
                        current = Some(candidate);
                    }
                    Some(best) if candidate.offset >= best.offset => {}
                    _ => current = Some(candidate),
                }
            } else if let Some(run_best) = current.take() {
                found.push(run_best);
            }
        }
        found.extend(current);
        if found.is_empty() {
            found.extend(nearest);
        }
        found
    }

    /// The position `s` meters along the line, clamped to its ends.
    pub fn point_at(&self, s: f32) -> [f32; 2] {
        let s = s.clamp(0.0, self.length());
        let index = self.cum.partition_point(|c| *c <= s);
        let upper = index.min(self.xy.len() - 1);
        let lower = upper.saturating_sub(1);
        let span = self.cum[upper] - self.cum[lower];
        if span <= 0.0 {
            return self.xy[lower];
        }
        let t = (s - self.cum[lower]) / span;
        [
            self.xy[lower][0] + (self.xy[upper][0] - self.xy[lower][0]) * t,
            self.xy[lower][1] + (self.xy[upper][1] - self.xy[lower][1]) * t,
        ]
    }

    /// Compass bearing of travel at `s`, measured over a short baseline.
    pub fn bearing_at(&self, s: f32) -> f32 {
        let a = self.point_at(s - 20.0);
        let b = self.point_at(s + 20.0);
        (b[0] - a[0])
            .atan2(b[1] - a[1])
            .to_degrees()
            .rem_euclid(360.0)
    }

    fn segments_between(&self, s_lo: f32, s_hi: f32) -> std::ops::Range<usize> {
        let last = self.xy.len().saturating_sub(1);
        let start = self.cum.partition_point(|c| *c <= s_lo).saturating_sub(1);
        let end = self.cum.partition_point(|c| *c < s_hi).min(last);
        start.min(last)..end.max(start.min(last) + 1).min(last)
    }

    fn project_on_segment(&self, point: [f32; 2], segment: usize) -> Projection {
        let a = self.xy[segment];
        let b = self.xy[segment + 1];
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let length_squared = dx * dx + dy * dy;
        let t = if length_squared > 0.0 {
            (((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length_squared).clamp(0.0, 1.0)
        } else {
            0.0
        };
        let projected = [a[0] + dx * t, a[1] + dy * t];
        Projection {
            s: self.cum[segment] + (self.cum[segment + 1] - self.cum[segment]) * t,
            offset: distance(point, projected),
        }
    }
}

fn fits_better_further_on(candidate: Projection, current: Projection) -> bool {
    candidate.offset + LATER_FIT_COST * (candidate.s - current.s) < current.offset
}

pub fn distance(a: [f32; 2], b: [f32; 2]) -> f32 {
    let (dx, dy) = (a[0] - b[0], a[1] - b[1]);
    (dx * dx + dy * dy).sqrt()
}

/// Places each stop along the line so positions never go backward, minimising
/// the total distance from stop to line. Dynamic programming over candidate
/// passes handles loops and out-and-back shapes that defeat a greedy search.
/// Near-ties go to the earlier pass.
pub fn assign_stop_positions(line: &Polyline, stops: &[[f32; 2]]) -> Vec<f32> {
    const MAX_OFFSET: f32 = 120.0;
    if stops.is_empty() {
        return Vec::new();
    }
    let candidates: Vec<Vec<Projection>> = stops
        .iter()
        .map(|stop| line.candidates(*stop, MAX_OFFSET))
        .collect();

    // best[i][j] = lowest total cost ending with stop i on candidate j.
    let mut best: Vec<Vec<f32>> = Vec::with_capacity(stops.len());
    let mut from: Vec<Vec<usize>> = Vec::with_capacity(stops.len());
    let cost = |c: &Projection| c.offset + LATER_PASS_COST * c.s;
    best.push(candidates[0].iter().map(cost).collect());
    from.push(vec![0; candidates[0].len()]);
    for i in 1..stops.len() {
        let mut row = Vec::with_capacity(candidates[i].len());
        let mut back = Vec::with_capacity(candidates[i].len());
        for candidate in &candidates[i] {
            let mut lowest = f32::INFINITY;
            let mut origin = 0;
            for (j, previous) in candidates[i - 1].iter().enumerate() {
                // Allow a small overlap: consecutive stops can project to one point.
                let penalty = if previous.s <= candidate.s + 5.0 {
                    0.0
                } else {
                    1e6
                };
                let total = best[i - 1][j] + cost(candidate) + penalty;
                if total < lowest {
                    lowest = total;
                    origin = j;
                }
            }
            row.push(lowest);
            back.push(origin);
        }
        best.push(row);
        from.push(back);
    }

    let mut positions = vec![0.0_f32; stops.len()];
    let mut index = best[stops.len() - 1]
        .iter()
        .enumerate()
        .min_by(|a, b| a.1.total_cmp(b.1))
        .map_or(0, |(i, _)| i);
    for i in (0..stops.len()).rev() {
        positions[i] = candidates[i].get(index).map_or(0.0, |c| c.s);
        index = from[i].get(index).copied().unwrap_or(0);
    }
    // Remove any residual overlap so later arithmetic can trust the ordering.
    for i in 1..positions.len() {
        positions[i] = positions[i].max(positions[i - 1]);
    }
    positions
}

#[cfg(test)]
mod tests {
    use super::*;

    fn straight() -> Polyline {
        // About 1.1 km due north.
        Polyline::from_lat_lon(&[(43.0, -89.0), (43.005, -89.0), (43.01, -89.0)]).unwrap()
    }

    #[test]
    fn cumulative_distance_is_close_to_true_length() {
        let line = straight();
        assert!((line.length() - 1113.2).abs() < 1.0, "{}", line.length());
    }

    #[test]
    fn projection_reports_position_and_perpendicular_offset() {
        let line = straight();
        let point = line.frame.to_xy(43.005, -88.9995);
        let found = line.nearest_in_window(point, 0.0, line.length()).unwrap();
        assert!((found.s - line.length() / 2.0).abs() < 1.0);
        assert!((found.offset - 40.6).abs() < 1.0, "{}", found.offset);
    }

    #[test]
    fn window_keeps_the_match_on_the_correct_pass_of_an_out_and_back_line() {
        let line = Polyline::from_lat_lon(&[(43.0, -89.0), (43.01, -89.0), (43.0, -89.0)]).unwrap();
        let point = line.frame.to_xy(43.005, -89.0);
        let outbound = line.nearest_in_window(point, 0.0, 1000.0).unwrap();
        let inbound = line
            .nearest_in_window(point, 1200.0, line.length())
            .unwrap();
        assert!(outbound.s < 600.0);
        assert!(inbound.s > 1600.0);
    }

    #[test]
    fn stop_positions_stay_ordered_on_a_line_that_doubles_back() {
        let line = Polyline::from_lat_lon(&[(43.0, -89.0), (43.01, -89.0), (43.0, -89.0)]).unwrap();
        let stops: Vec<[f32; 2]> = [
            (43.002, -89.0),
            (43.008, -89.0),
            (43.008, -89.0),
            (43.002, -89.0),
        ]
        .iter()
        .map(|(lat, lon)| line.frame.to_xy(*lat, *lon))
        .collect();
        let positions = assign_stop_positions(&line, &stops);
        assert!(positions.windows(2).all(|w| w[0] <= w[1]), "{positions:?}");
        assert!(
            positions[0] < 300.0 && positions[3] > 1900.0,
            "{positions:?}"
        );
    }

    /// Runs north from 43.0, with points every `step` degrees of latitude.
    fn road(count: usize, step: f64) -> Vec<(f64, f64)> {
        (0..count)
            .map(|i| (43.0 + step * i as f64, -89.0))
            .collect()
    }

    #[test]
    fn a_detour_to_a_stop_is_removed_and_the_line_keeps_its_true_length() {
        let mut points = road(6, 0.0005); // about 55 m apart
        // Road, then 14 m sideways to the curb, then back to the road 20 m on.
        points.insert(3, (43.0011, -88.99983));
        points.insert(4, (43.0012, -89.0));
        let with_spike = Polyline::from_lat_lon(&points).unwrap();
        let cleaned = remove_spikes(&points);
        let without = Polyline::from_lat_lon(&cleaned).unwrap();
        assert_eq!(cleaned.len(), points.len() - 1);
        assert!(with_spike.length() > without.length() + 10.0);
        let straight = Polyline::from_lat_lon(&road(6, 0.0005)).unwrap();
        assert!((without.length() - straight.length()).abs() < 1.0);
    }

    #[test]
    fn a_detour_that_returns_to_the_same_point_on_the_road_is_removed() {
        let mut points = road(5, 0.0005);
        points.insert(3, (43.001, -88.99983));
        points.insert(4, (43.001, -89.0));
        assert_eq!(remove_spikes(&points).len(), points.len() - 1);
    }

    #[test]
    fn a_real_street_corner_with_short_blocks_is_kept() {
        // North, then a right-angle turn east, with short segments at the corner.
        let points = vec![
            (43.0, -89.0),
            (43.001, -89.0),
            (43.0013, -89.0),
            (43.0013, -88.9996),
            (43.0013, -88.9986),
        ];
        assert_eq!(remove_spikes(&points), points);
    }

    #[test]
    fn a_u_turn_at_the_end_of_a_line_is_kept() {
        let points = vec![
            (43.0, -89.0),
            (43.001, -89.0),
            (43.0013, -89.0),
            (43.0010, -89.00002),
            (43.0, -89.00002),
        ];
        assert_eq!(remove_spikes(&points), points);
    }

    #[test]
    fn the_earlier_pass_wins_unless_it_is_clearly_worse() {
        // North along one street, around a block, and back south 20 m away.
        let line = Polyline::from_lat_lon(&[
            (43.0, -89.0),
            (43.02, -89.0),
            (43.02, -88.99975),
            (43.0, -88.99975),
        ])
        .unwrap();
        // Right on the return leg, and 20 m from the outbound leg.
        let point = line.frame.to_xy(43.01, -88.99975);
        let plain = line.nearest_in_window(point, 0.0, line.length()).unwrap();
        assert!(
            plain.s > line.length() / 2.0,
            "the nearest point is on the way back"
        );
        let earliest = line
            .earliest_pass_in_window(point, 0.0, line.length(), 25.0)
            .unwrap();
        assert!(earliest.s < line.length() / 2.0, "{}", earliest.s);
        // Clearly nearer the return leg, so that is where the vehicle is.
        let earliest = line
            .earliest_pass_in_window(point, 0.0, line.length(), 10.0)
            .unwrap();
        assert!(earliest.s > line.length() / 2.0, "{}", earliest.s);
    }

    #[test]
    fn a_hook_at_the_end_of_a_line_is_reached_rather_than_stopped_short_of() {
        // North along the road, then a short hook out to the terminal and back.
        let line = Polyline::from_lat_lon(&[
            (43.0, -89.0),
            (43.0009, -89.0),
            (43.0009, -88.9995),
            (43.00092, -88.9995),
            (43.00092, -89.0),
        ])
        .unwrap();
        // At the tip of the hook, about 40 m from the road.
        let point = line.frame.to_xy(43.00091, -88.9995);
        let found = line
            .earliest_pass_in_window(point, 0.0, line.length(), 25.0)
            .unwrap();
        assert!(found.offset < 3.0, "{found:?}");
    }

    #[test]
    fn a_second_pass_far_along_the_line_is_not_taken_for_the_same_pass() {
        let line = Polyline::from_lat_lon(&[
            (43.0, -89.0),
            (43.02, -89.0),
            (43.02, -88.99975),
            (43.0, -88.99975),
        ])
        .unwrap();
        // Right on the return leg, more than the span away from the outbound one.
        let point = line.frame.to_xy(43.01, -88.99975);
        let found = line
            .earliest_pass_in_window(point, 0.0, line.length(), 25.0)
            .unwrap();
        assert!(found.s < line.length() / 2.0, "{}", found.s);
    }

    #[test]
    fn a_stop_that_fits_two_passes_equally_goes_on_the_earlier_one() {
        let line = Polyline::from_lat_lon(&[
            (43.0, -89.0),
            (43.02, -89.0),
            (43.02, -88.99975),
            (43.0, -88.99975),
        ])
        .unwrap();
        // Halfway between the two legs of the street.
        let stop = line.frame.to_xy(43.01, -88.999875);
        let positions = assign_stop_positions(&line, &[stop]);
        assert!(positions[0] < line.length() / 2.0, "{}", positions[0]);
    }

    #[test]
    fn a_stop_clearly_on_the_later_pass_stays_there() {
        let line = Polyline::from_lat_lon(&[
            (43.0, -89.0),
            (43.002, -89.0),
            (43.002, -88.9985),
            (43.0, -88.9985),
        ])
        .unwrap();
        let stop = line.frame.to_xy(43.001, -88.9985);
        let positions = assign_stop_positions(&line, &[stop]);
        assert!(positions[0] > line.length() / 2.0, "{}", positions[0]);
    }

    #[test]
    fn rejects_lines_without_two_distinct_points() {
        assert!(Polyline::from_lat_lon(&[(43.0, -89.0), (43.0, -89.0)]).is_none());
        assert!(Polyline::from_lat_lon(&[(0.0, 0.0), (43.0, -89.0)]).is_none());
    }

    #[test]
    fn bearing_points_in_the_direction_of_travel() {
        let line = straight();
        let bearing = line.bearing_at(500.0);
        assert!(bearing < 1.0 || bearing > 359.0, "{bearing}");
    }
}
