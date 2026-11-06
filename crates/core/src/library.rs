//! Merges days analysed under different schedule versions.
//!
//! Each cached day refers to its own schedule's row numbers. Adding a day to the
//! library rewrites those references onto one shared set of routes, stops and
//! segments, keyed by stable IDs and geography.

use crate::cube::{DayCube, StopEvent};
use crate::schedule::{Bin, Pattern, RouteMeta, ScheduleMeta, SegKey, SegMeta, StopMeta};
use rustc_hash::FxHashMap;
use std::collections::BTreeMap;

/// Directional street cell, pooled across every route that runs through it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct CorridorKey {
    pub x: i32,
    pub y: i32,
    pub sector: u8,
}

#[derive(Clone, Debug, Default)]
pub struct Corridor {
    pub segs: Vec<u32>,
    /// The longest member segment, whose line represents the corridor.
    pub representative: u32,
}

struct Remap {
    routes: Vec<u32>,
    stops: Vec<u32>,
    segs: Vec<u32>,
    patterns: Vec<u32>,
}

/// Every analysed day for one feed, on shared indexes.
#[derive(Default)]
pub struct Library {
    pub routes: Vec<RouteMeta>,
    route_ids: FxHashMap<String, u32>,
    pub stops: Vec<StopMeta>,
    stop_ids: FxHashMap<String, u32>,
    pub segs: Vec<SegMeta>,
    seg_ids: FxHashMap<SegKey, u32>,
    pub seg_corridor: Vec<u32>,
    pub corridors: Vec<Corridor>,
    corridor_ids: FxHashMap<CorridorKey, u32>,
    pub patterns: Vec<Pattern>,
    pattern_ids: FxHashMap<(u32, u8, String, Vec<u32>), u32>,
    pub days: BTreeMap<u32, DayCube>,
    pub events: FxHashMap<u32, Vec<StopEvent>>,
    pub center: (f64, f64),
    pub timezone: Option<String>,
    remaps: FxHashMap<String, Remap>,
}

impl Library {
    pub fn has_schedule(&self, digest: &str) -> bool {
        self.remaps.contains_key(digest)
    }

    /// Registers a schedule version. Safe to repeat.
    pub fn add_schedule(&mut self, meta: &ScheduleMeta) {
        if self.has_schedule(&meta.digest) {
            return;
        }
        if self.center == (0.0, 0.0) {
            self.center = meta.center;
        }
        if self.timezone.is_none() {
            self.timezone.clone_from(&meta.timezone);
        }
        let routes: Vec<u32> = meta
            .routes
            .iter()
            .map(|route| self.intern_route(route))
            .collect();
        let stops: Vec<u32> = meta
            .stops
            .iter()
            .map(|stop| self.intern_stop(stop))
            .collect();
        let segs: Vec<u32> = meta
            .segs
            .iter()
            .map(|seg| self.intern_seg(seg, &routes))
            .collect();
        let patterns: Vec<u32> = meta
            .patterns
            .iter()
            .map(|pattern| self.intern_pattern(pattern, &routes, &stops, &segs))
            .collect();
        self.remaps.insert(
            meta.digest.clone(),
            Remap {
                routes,
                stops,
                segs,
                patterns,
            },
        );
    }

    fn intern_route(&mut self, route: &RouteMeta) -> u32 {
        match self.route_ids.get(&route.id) {
            Some(index) => *index,
            None => {
                let index = self.routes.len() as u32;
                self.route_ids.insert(route.id.clone(), index);
                self.routes.push(route.clone());
                index
            }
        }
    }

    fn intern_stop(&mut self, stop: &StopMeta) -> u32 {
        match self.stop_ids.get(&stop.id) {
            Some(index) => *index,
            None => {
                let index = self.stops.len() as u32;
                self.stop_ids.insert(stop.id.clone(), index);
                self.stops.push(stop.clone());
                index
            }
        }
    }

    fn intern_seg(&mut self, seg: &SegMeta, routes: &[u32]) -> u32 {
        let key = SegKey {
            route: routes[seg.key.route as usize],
            ..seg.key
        };
        if let Some(index) = self.seg_ids.get(&key) {
            return *index;
        }
        let index = self.segs.len() as u32;
        self.seg_ids.insert(key, index);
        self.segs.push(SegMeta {
            key,
            length_m: seg.length_m,
            path: seg.path.clone(),
        });
        let corridor_key = CorridorKey {
            x: key.x,
            y: key.y,
            sector: key.sector,
        };
        let corridor = match self.corridor_ids.get(&corridor_key) {
            Some(corridor) => *corridor,
            None => {
                let corridor = self.corridors.len() as u32;
                self.corridor_ids.insert(corridor_key, corridor);
                self.corridors.push(Corridor {
                    segs: Vec::new(),
                    representative: index,
                });
                corridor
            }
        };
        let entry = &mut self.corridors[corridor as usize];
        entry.segs.push(index);
        if seg.length_m > self.segs[entry.representative as usize].length_m {
            entry.representative = index;
        }
        self.seg_corridor.push(corridor);
        index
    }

    fn intern_pattern(
        &mut self,
        pattern: &Pattern,
        routes: &[u32],
        stops: &[u32],
        segs: &[u32],
    ) -> u32 {
        let route = routes[pattern.route as usize];
        let stop_list: Vec<u32> = pattern
            .stops
            .iter()
            .map(|stop| stops[*stop as usize])
            .collect();
        let key = (route, pattern.dir, pattern.shape_id.clone(), stop_list);
        if let Some(index) = self.pattern_ids.get(&key) {
            self.patterns[*index as usize].trip_count += pattern.trip_count;
            return *index;
        }
        let index = self.patterns.len() as u32;
        let stop_list = key.3.clone();
        self.pattern_ids.insert(key, index);
        self.patterns.push(Pattern {
            route,
            stops: stop_list,
            bins: pattern
                .bins
                .iter()
                .map(|bin| Bin {
                    seg: segs[bin.seg as usize],
                    ..*bin
                })
                .collect(),
            ..pattern.clone()
        });
        index
    }

    /// Adds a day. Its schedule must already be registered.
    pub fn add_day(
        &mut self,
        mut cube: DayCube,
        events: Option<Vec<StopEvent>>,
    ) -> Result<(), String> {
        let Some(remap) = self.remaps.get(&cube.digest) else {
            return Err(format!("Day {} refers to an unknown schedule.", cube.date));
        };
        for row in &mut cube.route_hours {
            row.route = remap.routes[row.route as usize];
        }
        for row in &mut cube.seg_hours {
            row.seg = remap.segs[row.seg as usize];
        }
        for row in &mut cube.stop_periods {
            row.route = remap.routes[row.route as usize];
            row.stop = remap.stops[row.stop as usize];
        }
        for row in &mut cube.trips {
            row.route = remap.routes[row.route as usize];
            row.pattern = remap.patterns[row.pattern as usize];
        }
        for row in &mut cube.route_vehicles {
            row.route = remap.routes[row.route as usize];
        }
        let date = cube.date;
        self.days.insert(date, cube);
        if let Some(events) = events {
            self.events.insert(date, events);
        }
        Ok(())
    }

    pub fn route_index(&self, id: &str) -> Option<u32> {
        self.route_ids.get(id).copied()
    }

    pub fn stop_index(&self, id: &str) -> Option<u32> {
        self.stop_ids.get(id).copied()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cube::RouteHour;
    use crate::schedule::fixtures::line_route;

    #[test]
    fn days_under_different_schedule_versions_land_on_the_same_route() {
        let mut first = line_route().meta();
        let mut second = first.clone();
        first.digest = "a".into();
        second.digest = "b".into();
        // The second version lists an extra route first, shifting row numbers.
        let mut extra = second.routes[0].clone();
        extra.id = "NEW".into();
        second.routes.insert(0, extra);
        for pattern in &mut second.patterns {
            pattern.route += 1;
        }
        for seg in &mut second.segs {
            seg.key.route += 1;
        }

        let mut library = Library::default();
        library.add_schedule(&first);
        library.add_schedule(&second);
        assert_eq!(library.routes.len(), 2);
        assert_eq!(library.segs.len(), first.segs.len());
        assert_eq!(
            library.patterns.len(),
            1,
            "same shape and stops is one pattern"
        );

        let day = |date: u32, digest: &str, route: u32| DayCube {
            date,
            digest: digest.into(),
            route_hours: vec![RouteHour {
                route,
                ..RouteHour::default()
            }],
            ..DayCube::default()
        };
        library.add_day(day(1, "a", 0), None).unwrap();
        library.add_day(day(2, "b", 1), None).unwrap();
        assert_eq!(
            library.days[&1].route_hours[0].route,
            library.days[&2].route_hours[0].route
        );
    }

    #[test]
    fn an_unregistered_schedule_is_an_error() {
        let mut library = Library::default();
        let cube = DayCube {
            digest: "missing".into(),
            ..DayCube::default()
        };
        assert!(library.add_day(cube, None).is_err());
    }

    #[test]
    fn repeating_a_schedule_is_harmless() {
        let meta = line_route().meta();
        let mut library = Library::default();
        library.add_schedule(&meta);
        let segs = library.segs.len();
        library.add_schedule(&meta);
        assert_eq!(library.segs.len(), segs);
    }

    #[test]
    fn opposite_directions_on_one_street_are_separate_corridors() {
        let mut meta = line_route().meta();
        let mut library = Library::default();
        library.add_schedule(&meta);
        let corridors = library.corridors.len();
        meta.digest = "reverse".into();
        for seg in &mut meta.segs {
            seg.key.sector = (seg.key.sector + 4) % 8;
            seg.key.dir = 1;
        }
        library.add_schedule(&meta);
        assert_eq!(library.corridors.len(), corridors * 2);
    }
}
