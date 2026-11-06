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

pub fn distance(a: [f32; 2], b: [f32; 2]) -> f32 {
    let (dx, dy) = (a[0] - b[0], a[1] - b[1]);
    (dx * dx + dy * dy).sqrt()
}

/// Places each stop along the line so positions never go backward, minimising
/// the total distance from stop to line. Dynamic programming over candidate
/// passes handles loops and out-and-back shapes that defeat a greedy search.
pub fn assign_stop_positions(line: &Polyline, stops: &[[f32; 2]]) -> Vec<f32> {
    const MAX_OFFSET: f32 = 120.0;
    if stops.is_empty() {
        return Vec::new();
    }
    let candidates: Vec<Vec<Projection>> = stops
        .iter()
        .map(|stop| line.candidates(*stop, MAX_OFFSET))
        .collect();

    // best[i][j] = lowest total offset ending with stop i on candidate j.
    let mut best: Vec<Vec<f32>> = Vec::with_capacity(stops.len());
    let mut from: Vec<Vec<usize>> = Vec::with_capacity(stops.len());
    best.push(candidates[0].iter().map(|c| c.offset).collect());
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
                let total = best[i - 1][j] + candidate.offset + penalty;
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
