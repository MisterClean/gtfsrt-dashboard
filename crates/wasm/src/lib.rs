//! The analytics engine as the Web Worker sees it.
//!
//! Columns arrive as borrowed typed arrays straight from Arrow, so millions of
//! rows cross the boundary without per-value conversion. Text columns come as
//! Arrow's own offsets and bytes. Reports go back as JSON strings.
#![cfg(target_arch = "wasm32")]

use js_sys::{Float64Array, Object, Reflect, Uint8Array};
use transit_core::cube::{
    self, CachedSchedule, Coverage, DayCube, DayStatus, METRIC_VERSION, StopEvent,
};
use transit_core::day::process_day;
use transit_core::gps::{self, PositionOptions};
use transit_core::library::Library;
use transit_core::report::{self, Merged, Selection};
use transit_core::rt::{RawFix, RtBuffer};
use transit_core::schedule::{RouteMeta, Schedule, ScheduleBuilder, StopMeta, parse_gtfs_time};
use transit_core::time::{Clock, ServiceDate};
use transit_core::{plan, sql};
use wasm_bindgen::prelude::*;

/// Arrow's variable-length text layout: `offsets[i]..offsets[i + 1]` into `bytes`.
#[derive(Clone, Copy)]
struct TextColumn<'a> {
    offsets: &'a [i32],
    bytes: &'a [u8],
}

impl<'a> TextColumn<'a> {
    fn new(offsets: &'a [i32], bytes: &'a [u8]) -> Self {
        Self { offsets, bytes }
    }

    fn get(&self, row: usize) -> Option<&'a [u8]> {
        let start = *self.offsets.get(row)? as usize;
        let end = *self.offsets.get(row + 1)? as usize;
        let value = self.bytes.get(start..end)?;
        (!value.is_empty()).then_some(value)
    }

    fn text(&self, row: usize) -> &'a str {
        self.get(row)
            .and_then(|value| std::str::from_utf8(value).ok())
            .unwrap_or("")
    }
}

fn error(message: impl Into<String>) -> JsError {
    JsError::new(&message.into())
}

fn set(target: &Object, key: &str, value: &JsValue) -> Result<(), JsError> {
    Reflect::set(target, &JsValue::from_str(key), value)
        .map(|_| ())
        .map_err(|_| error("Could not build a result object."))
}

/// A batch whose columns disagree in length would otherwise panic mid-loop.
fn check_lengths(rows: usize, columns: &[usize]) -> Result<(), JsError> {
    if columns.iter().all(|length| *length == rows) {
        Ok(())
    } else {
        Err(error(
            "A batch of archive data has columns of different lengths.",
        ))
    }
}

fn coverage_and_notes(
    read_through: f64,
    missing: &str,
    notes: &str,
) -> Result<(Coverage, Vec<String>), JsError> {
    let missing: Vec<(f64, f64)> =
        serde_json::from_str(missing).map_err(|e| error(format!("Invalid file list: {e}")))?;
    let notes: Vec<String> =
        serde_json::from_str(notes).map_err(|e| error(format!("Invalid notes: {e}")))?;
    Ok((
        Coverage {
            read_through: read_through as i64,
            missing: missing
                .into_iter()
                .map(|(start, end)| (start as i64, end as i64))
                .collect(),
        },
        notes,
    ))
}

fn status_name(status: DayStatus) -> &'static str {
    match status {
        DayStatus::Complete => "complete",
        DayStatus::Partial => "partial",
        DayStatus::NoData => "no_data",
    }
}

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

/// All analytical state for one feed.
#[wasm_bindgen]
pub struct Engine {
    clock: Clock,
    builder: Option<ScheduleBuilder>,
    schedules: Vec<Schedule>,
    buffer: RtBuffer,
    library: Library,
    catalogs: Vec<plan::ScheduleCatalog>,
    selection: Option<Selection>,
    /// Recomputed on demand. Anything that changes the library clears it, so a report
    /// can never read sums from before a day or schedule arrived.
    merged: Option<Merged>,
}

impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}

#[wasm_bindgen]
impl Engine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            clock: Clock::fixed(0),
            builder: None,
            schedules: Vec::new(),
            buffer: RtBuffer::default(),
            library: Library::default(),
            catalogs: Vec::new(),
            selection: None,
            merged: None,
        }
    }

    /// `samples` holds alternating epoch seconds and UTC offsets in seconds.
    #[wasm_bindgen(js_name = setClock)]
    pub fn set_clock(&mut self, samples: &Float64Array) {
        let values = samples.to_vec();
        let pairs = values
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| (pair[0] as i64, pair[1] as i32))
            .collect();
        self.clock = Clock::from_samples(pairs);
    }

    /// Service origin of a date in epoch seconds.
    #[wasm_bindgen(js_name = serviceOrigin)]
    pub fn service_origin(&self, date: u32) -> Option<f64> {
        self.clock
            .service_origin(ServiceDate(date))
            .map(|v| v as f64)
    }

    // ---- Schedule loading ---------------------------------------------------

    #[wasm_bindgen(js_name = hasSchedule)]
    pub fn has_schedule(&self, digest: &str) -> bool {
        self.library.has_schedule(digest)
    }

    #[wasm_bindgen(js_name = isCompiled)]
    pub fn is_compiled(&self, digest: &str) -> bool {
        self.schedules.iter().any(|s| s.digest == digest)
    }

    #[wasm_bindgen(js_name = beginSchedule)]
    pub fn begin_schedule(&mut self, digest: &str) {
        self.builder = Some(ScheduleBuilder::new(digest));
    }

    fn builder(&mut self) -> Result<&mut ScheduleBuilder, JsError> {
        self.builder
            .as_mut()
            .ok_or_else(|| error("A schedule must be started before adding rows."))
    }

    /// Records a problem to show with every day using the schedule being built.
    #[wasm_bindgen(js_name = addScheduleWarning)]
    pub fn add_schedule_warning(&mut self, warning: String) -> Result<(), JsError> {
        self.builder()?.add_warning(warning);
        Ok(())
    }

    #[wasm_bindgen(js_name = setTimezone)]
    pub fn set_timezone(&mut self, timezone: &str) -> Result<(), JsError> {
        self.builder()?.set_timezone(timezone);
        Ok(())
    }

    #[wasm_bindgen(js_name = addRoute)]
    #[allow(clippy::too_many_arguments)]
    pub fn add_route(
        &mut self,
        id: String,
        short_name: String,
        long_name: String,
        route_type: Option<i32>,
        color: String,
        text_color: String,
    ) -> Result<(), JsError> {
        self.builder()?.add_route(RouteMeta {
            id,
            short_name,
            long_name,
            route_type,
            color,
            text_color,
        });
        Ok(())
    }

    #[wasm_bindgen(js_name = addStop)]
    pub fn add_stop(
        &mut self,
        id: String,
        code: String,
        name: String,
        lat: f64,
        lon: f64,
    ) -> Result<(), JsError> {
        self.builder()?.add_stop(StopMeta {
            id,
            code,
            name,
            lat,
            lon,
        });
        Ok(())
    }

    #[wasm_bindgen(js_name = addCalendar)]
    #[allow(clippy::too_many_arguments)]
    pub fn add_calendar(
        &mut self,
        service_id: &str,
        monday: bool,
        tuesday: bool,
        wednesday: bool,
        thursday: bool,
        friday: bool,
        saturday: bool,
        sunday: bool,
        start: u32,
        end: u32,
    ) -> Result<(), JsError> {
        self.builder()?.add_calendar(
            service_id,
            [
                monday, tuesday, wednesday, thursday, friday, saturday, sunday,
            ],
            start,
            end,
        );
        Ok(())
    }

    #[wasm_bindgen(js_name = addCalendarDate)]
    pub fn add_calendar_date(
        &mut self,
        service_id: &str,
        date: u32,
        kind: i32,
    ) -> Result<(), JsError> {
        self.builder()?.add_calendar_date(service_id, date, kind);
        Ok(())
    }

    #[wasm_bindgen(js_name = addTrip)]
    pub fn add_trip(
        &mut self,
        trip_id: &str,
        route_id: &str,
        service_id: &str,
        direction: Option<u8>,
        shape_id: Option<String>,
        headsign: &str,
    ) -> Result<(), JsError> {
        self.builder()?.add_trip(
            trip_id,
            route_id,
            service_id,
            direction,
            shape_id.as_deref(),
            headsign,
        );
        Ok(())
    }

    /// One batch of shape points. Coordinates are parsed by the engine.
    #[wasm_bindgen(js_name = pushShapes)]
    #[allow(clippy::too_many_arguments)]
    pub fn push_shapes(
        &mut self,
        shape_offsets: &[i32],
        shape_bytes: &[u8],
        sequence: &[i32],
        lat: &[f64],
        lon: &[f64],
    ) -> Result<(), JsError> {
        check_lengths(
            sequence.len(),
            &[lat.len(), lon.len(), shape_offsets.len().saturating_sub(1)],
        )?;
        let builder = self.builder()?;
        let shape = TextColumn::new(shape_offsets, shape_bytes);
        for row in 0..sequence.len() {
            builder.add_shape_point(shape.text(row), sequence[row], lat[row], lon[row]);
        }
        Ok(())
    }

    /// One batch of stop times. `timepoint` holds -1 for blank, else 0 or 1.
    #[wasm_bindgen(js_name = pushStopTimes)]
    #[allow(clippy::too_many_arguments)]
    pub fn push_stop_times(
        &mut self,
        trip_offsets: &[i32],
        trip_bytes: &[u8],
        stop_offsets: &[i32],
        stop_bytes: &[u8],
        sequence: &[i32],
        arrival_offsets: &[i32],
        arrival_bytes: &[u8],
        departure_offsets: &[i32],
        departure_bytes: &[u8],
        timepoint: &[i8],
    ) -> Result<(), JsError> {
        check_lengths(
            sequence.len(),
            &[
                timepoint.len(),
                trip_offsets.len().saturating_sub(1),
                stop_offsets.len().saturating_sub(1),
                arrival_offsets.len().saturating_sub(1),
                departure_offsets.len().saturating_sub(1),
            ],
        )?;
        let builder = self.builder()?;
        let trip = TextColumn::new(trip_offsets, trip_bytes);
        let stop = TextColumn::new(stop_offsets, stop_bytes);
        let arrival = TextColumn::new(arrival_offsets, arrival_bytes);
        let departure = TextColumn::new(departure_offsets, departure_bytes);
        for row in 0..sequence.len() {
            builder.add_stop_time(
                trip.text(row),
                stop.text(row),
                sequence[row],
                parse_gtfs_time(arrival.text(row)),
                parse_gtfs_time(departure.text(row)),
                match timepoint[row] {
                    -1 => None,
                    value => Some(value == 1),
                },
            );
        }
        Ok(())
    }

    /// Compiles the schedule and returns its metadata for the local cache.
    #[wasm_bindgen(js_name = finishSchedule)]
    pub fn finish_schedule(&mut self) -> Result<Vec<u8>, JsError> {
        let builder = self
            .builder
            .take()
            .ok_or_else(|| error("No schedule is being built."))?;
        let schedule = builder.build().map_err(error)?;
        let meta = schedule.meta();
        self.library.add_schedule(&meta);
        self.merged = None;
        // Older schedules only matter while their days are being read.
        self.schedules.push(schedule);
        if self.schedules.len() > 2 {
            self.schedules.remove(0);
        }
        cube::encode(&CachedSchedule {
            metric_version: METRIC_VERSION,
            meta,
        })
        .map_err(error)
    }

    /// Restores schedule metadata from the local cache. Returns false when the
    /// cached copy came from an older calculation and must be rebuilt.
    #[wasm_bindgen(js_name = importSchedule)]
    pub fn import_schedule(&mut self, bytes: &[u8]) -> Result<bool, JsError> {
        let cached: CachedSchedule = cube::decode(bytes).map_err(error)?;
        if cached.metric_version != METRIC_VERSION {
            return Ok(false);
        }
        self.library.add_schedule(&cached.meta);
        self.merged = None;
        Ok(true)
    }

    #[wasm_bindgen(js_name = scheduleTimezone)]
    pub fn schedule_timezone(&self) -> Option<String> {
        self.schedules
            .last()
            .and_then(|s| s.timezone.clone())
            .or_else(|| self.library.timezone.clone())
    }

    #[wasm_bindgen(js_name = scheduleWarnings)]
    pub fn schedule_warnings(&self) -> String {
        let warnings = self
            .schedules
            .last()
            .map(|s| s.warnings.clone())
            .unwrap_or_default();
        serde_json::to_string(&warnings).unwrap_or_else(|_| "[]".to_owned())
    }

    // ---- Realtime -----------------------------------------------------------

    /// One batch of vehicle positions. All columns have the same length.
    #[wasm_bindgen(js_name = pushFixes)]
    #[allow(clippy::too_many_arguments)]
    pub fn push_fixes(
        &mut self,
        fetch: &[f64],
        timestamp: &[f64],
        lat: &[f32],
        lon: &[f32],
        occupancy: &[i8],
        differential: &[i8],
        trip_offsets: &[i32],
        trip_bytes: &[u8],
        vehicle_offsets: &[i32],
        vehicle_bytes: &[u8],
        route_offsets: &[i32],
        route_bytes: &[u8],
        start_date_offsets: &[i32],
        start_date_bytes: &[u8],
        start_time_offsets: &[i32],
        start_time_bytes: &[u8],
    ) -> Result<(), JsError> {
        check_lengths(
            fetch.len(),
            &[
                timestamp.len(),
                lat.len(),
                lon.len(),
                occupancy.len(),
                differential.len(),
                trip_offsets.len().saturating_sub(1),
                vehicle_offsets.len().saturating_sub(1),
                route_offsets.len().saturating_sub(1),
                start_date_offsets.len().saturating_sub(1),
                start_time_offsets.len().saturating_sub(1),
            ],
        )?;
        let trip = TextColumn::new(trip_offsets, trip_bytes);
        let vehicle = TextColumn::new(vehicle_offsets, vehicle_bytes);
        let route = TextColumn::new(route_offsets, route_bytes);
        let start_date = TextColumn::new(start_date_offsets, start_date_bytes);
        let start_time = TextColumn::new(start_time_offsets, start_time_bytes);
        for row in 0..fetch.len() {
            self.buffer.push(RawFix {
                fetch: fetch[row],
                timestamp: timestamp[row],
                lat: lat[row],
                lon: lon[row],
                trip_id: trip.get(row),
                vehicle_id: vehicle.get(row),
                route_id: route.get(row),
                start_date: start_date.get(row),
                start_time: start_time.get(row),
                occupancy: occupancy[row],
                differential: differential[row] == 1,
            });
        }
        Ok(())
    }

    #[wasm_bindgen(js_name = fixCount)]
    pub fn fix_count(&self) -> f64 {
        self.buffer.fixes.len() as f64
    }

    #[wasm_bindgen(js_name = removeDay)]
    pub fn remove_day(&mut self, date: u32) {
        self.library.days.remove(&date);
        self.library.events.remove(&date);
        self.merged = None;
    }

    /// Accepts GPS observations that have no scheduled trip descriptor.
    #[wasm_bindgen(js_name = pushPositions)]
    #[allow(clippy::too_many_arguments)]
    pub fn push_positions(
        &mut self,
        fetch: &[f64],
        timestamp: &[f64],
        lat: &[f32],
        lon: &[f32],
        approximate: &[i8],
        vehicle_offsets: &[i32],
        vehicle_bytes: &[u8],
        route_offsets: &[i32],
        route_bytes: &[u8],
    ) -> Result<(), JsError> {
        check_lengths(
            fetch.len(),
            &[
                timestamp.len(),
                lat.len(),
                lon.len(),
                approximate.len(),
                vehicle_offsets.len().saturating_sub(1),
                route_offsets.len().saturating_sub(1),
            ],
        )?;
        let vehicle = TextColumn::new(vehicle_offsets, vehicle_bytes);
        let route = TextColumn::new(route_offsets, route_bytes);
        for row in 0..fetch.len() {
            self.buffer.push_position(
                RawFix {
                    fetch: fetch[row],
                    timestamp: timestamp[row],
                    lat: lat[row],
                    lon: lon[row],
                    trip_id: None,
                    vehicle_id: vehicle.get(row),
                    route_id: route.get(row),
                    start_date: None,
                    start_time: None,
                    occupancy: -1,
                    differential: false,
                },
                approximate[row] == 1,
            );
        }
        Ok(())
    }

    #[wasm_bindgen(js_name = gpsWindow)]
    pub fn gps_window(&self, date: u32) -> Result<Vec<f64>, JsError> {
        let origin = self
            .clock
            .service_origin(ServiceDate(date))
            .ok_or_else(|| error("This date is outside the supported calendar."))?;
        let window = gps::gps_window(origin);
        Ok(vec![window.start as f64, window.end as f64])
    }

    /// Fraction of buffered fixes whose trip ID exists in the compiled schedule.
    #[wasm_bindgen(js_name = tripMatchRate)]
    pub fn trip_match_rate(&self, digest: &str) -> f64 {
        let Some(schedule) = self.schedules.iter().find(|s| s.digest == digest) else {
            return 0.0;
        };
        let matched: Vec<bool> = (0..self.buffer.trips.len() as u32)
            .map(|id| schedule.trip_lookup.contains_key(self.buffer.trips.get(id)))
            .collect();
        let total = self.buffer.fixes.len();
        if total == 0 {
            return 0.0;
        }
        let hits = self
            .buffer
            .fixes
            .iter()
            .filter(|fix| {
                let descriptor = self.buffer.descriptors[fix.descriptor as usize];
                matched[descriptor.trip as usize]
            })
            .count();
        hits as f64 / total as f64
    }

    /// Analyses one service day from the buffer.
    ///
    /// `missing` is a JSON list of `[start, end]` epochs for archive files that don't
    /// exist, and `notes` a JSON list of messages to keep with the day. Returns the
    /// day's `status` with its encoded results. A day with no data stays out of the
    /// library, so it can't dilute any average.
    #[wasm_bindgen(js_name = processDay)]
    pub fn process_day(
        &mut self,
        date: u32,
        digest: &str,
        read_through: f64,
        missing: &str,
        notes: &str,
    ) -> Result<Object, JsError> {
        let schedule = self
            .schedules
            .iter()
            .find(|s| s.digest == digest)
            .ok_or_else(|| error("The schedule for this day is not loaded."))?;
        let (coverage, notes) = coverage_and_notes(read_through, missing, notes)?;
        let result = process_day(
            schedule,
            &mut self.buffer,
            ServiceDate(date),
            &self.clock,
            &coverage,
            &notes,
        )
        .map_err(error)?;
        let output = Object::new();
        set(&output, "status", &status_name(result.cube.status).into())?;
        if result.cube.status != DayStatus::NoData {
            let cube_bytes = cube::encode(&result.cube).map_err(error)?;
            let event_bytes = cube::encode(&result.events).map_err(error)?;
            self.library
                .add_day(result.cube, Some(result.events))
                .map_err(error)?;
            self.merged = None;
            set(
                &output,
                "cube",
                &Uint8Array::from(cube_bytes.as_slice()).into(),
            )?;
            set(
                &output,
                "events",
                &Uint8Array::from(event_bytes.as_slice()).into(),
            )?;
        }
        Ok(output)
    }

    /// Analyses a day from position alone, for feeds that can't join a schedule. Takes
    /// the same `missing` and `notes` as `processDay`.
    #[wasm_bindgen(js_name = processGpsDay)]
    pub fn process_gps_day(
        &mut self,
        date: u32,
        read_through: f64,
        missing: &str,
        notes: &str,
        positions: Option<String>,
    ) -> Result<Object, JsError> {
        let known = self
            .schedules
            .last()
            .map(|schedule| schedule.routes.clone())
            .unwrap_or_default();
        let (coverage, notes) = coverage_and_notes(read_through, missing, notes)?;
        let positions: Option<PositionOptions> = positions
            .as_deref()
            .map(serde_json::from_str)
            .transpose()
            .map_err(|e| error(format!("Invalid position options: {e}")))?;
        let day = gps::process_gps_day_with_options(
            &mut self.buffer,
            &known,
            ServiceDate(date),
            &self.clock,
            &coverage,
            &notes,
            positions.as_ref(),
        )
        .map_err(error)?;
        let output = Object::new();
        set(&output, "status", &status_name(day.cube.status).into())?;
        if day.cube.status != DayStatus::NoData {
            self.library.add_schedule(&day.meta);
            let meta_bytes = cube::encode(&CachedSchedule {
                metric_version: METRIC_VERSION,
                meta: day.meta,
            })
            .map_err(error)?;
            let cube_bytes = cube::encode(&day.cube).map_err(error)?;
            let digest = day.cube.digest.clone();
            self.library
                .add_day(day.cube, Some(Vec::new()))
                .map_err(error)?;
            self.merged = None;
            set(
                &output,
                "cube",
                &Uint8Array::from(cube_bytes.as_slice()).into(),
            )?;
            set(
                &output,
                "meta",
                &Uint8Array::from(meta_bytes.as_slice()).into(),
            )?;
            set(&output, "digest", &JsValue::from_str(&digest))?;
        }
        Ok(output)
    }

    /// Frees fixes older than the next day to be processed.
    #[wasm_bindgen(js_name = evictBefore)]
    pub fn evict_before(&mut self, epoch: f64) {
        self.buffer.evict_before(epoch as i64);
    }

    #[wasm_bindgen(js_name = clearBuffer)]
    pub fn clear_buffer(&mut self) {
        self.buffer = RtBuffer::default();
    }

    /// Restores a cached day. Returns false for an older calculation version.
    #[wasm_bindgen(js_name = importDay)]
    pub fn import_day(
        &mut self,
        cube_bytes: &[u8],
        event_bytes: Option<Vec<u8>>,
    ) -> Result<bool, JsError> {
        let cached: DayCube = cube::decode(cube_bytes).map_err(error)?;
        if cached.metric_version != METRIC_VERSION {
            return Ok(false);
        }
        let events: Option<Vec<StopEvent>> = match event_bytes {
            Some(bytes) => Some(cube::decode(&bytes).map_err(error)?),
            None => None,
        };
        self.library.add_day(cached, events).map_err(error)?;
        self.merged = None;
        Ok(true)
    }

    /// Releases a day's stop events from memory once they are safely in the cache.
    /// They are read back on demand, and otherwise add up over a long selection.
    #[wasm_bindgen(js_name = dropEvents)]
    pub fn drop_events(&mut self, date: u32) {
        self.library.events.remove(&date);
    }

    #[wasm_bindgen(js_name = hasEvents)]
    pub fn has_events(&self, date: u32) -> bool {
        self.library.events.contains_key(&date)
    }

    #[wasm_bindgen(js_name = importEvents)]
    pub fn import_events(&mut self, date: u32, bytes: &[u8]) -> Result<(), JsError> {
        let events: Vec<StopEvent> = cube::decode(bytes).map_err(error)?;
        self.library.events.insert(date, events);
        Ok(())
    }

    // ---- Reports ------------------------------------------------------------

    /// Applies a selection (JSON). Everything after this reads the merged sums.
    #[wasm_bindgen(js_name = select)]
    pub fn select(&mut self, selection: &str) -> Result<(), JsError> {
        let selection: Selection = serde_json::from_str(selection)
            .map_err(|e| error(format!("Invalid selection: {e}")))?;
        self.selection = Some(selection);
        self.merged = None;
        Ok(())
    }

    /// Merges the selected days if anything has changed since the last time.
    fn ensure_merged(&mut self) -> Result<(), JsError> {
        if self.merged.is_none() {
            let selection = self
                .selection
                .clone()
                .ok_or_else(|| error("Choose days to analyse first."))?;
            self.merged = Some(Merged::compute(&self.library, selection));
        }
        Ok(())
    }

    fn merged(&self) -> Result<&Merged, JsError> {
        self.merged
            .as_ref()
            .ok_or_else(|| error("Choose days to analyse first."))
    }

    fn json<T: serde::Serialize>(value: &T) -> Result<String, JsError> {
        serde_json::to_string(value).map_err(|e| error(format!("Could not encode a report: {e}")))
    }

    pub fn overview(&mut self) -> Result<String, JsError> {
        self.ensure_merged()?;
        Self::json(&report::overview(&self.library, self.merged()?))
    }

    pub fn routes(&mut self) -> Result<String, JsError> {
        self.ensure_merged()?;
        Self::json(&report::route_scores(&self.library, self.merged()?))
    }

    #[wasm_bindgen(js_name = networkMap)]
    pub fn network_map(&mut self, route: Option<String>) -> Result<String, JsError> {
        self.ensure_merged()?;
        Self::json(&report::network_map(
            &self.library,
            self.merged()?,
            route.as_deref(),
        ))
    }

    pub fn hotspots(&mut self) -> Result<String, JsError> {
        self.ensure_merged()?;
        Self::json(&report::hotspots(&self.library, self.merged()?))
    }

    #[wasm_bindgen(js_name = routeDetail)]
    pub fn route_detail(&mut self, route: &str) -> Result<String, JsError> {
        self.ensure_merged()?;
        Self::json(&report::route_detail(&self.library, self.merged()?, route))
    }

    #[wasm_bindgen(js_name = stringLine)]
    pub fn string_line(&mut self, route: &str, dir: u8, date: u32) -> Result<String, JsError> {
        self.ensure_merged()?;
        Self::json(&report::string_line(
            &self.library,
            self.merged()?,
            route,
            dir,
            date,
        ))
    }

    pub fn stops(&mut self) -> Result<String, JsError> {
        self.ensure_merged()?;
        Self::json(&report::stops_report(&self.library, self.merged()?))
    }

    pub fn quality(&mut self) -> Result<String, JsError> {
        self.ensure_merged()?;
        Self::json(&report::quality_report(&self.library, self.merged()?))
    }

    #[wasm_bindgen(js_name = metricVersion)]
    pub fn metric_version() -> u32 {
        METRIC_VERSION
    }

    // ---- Planning -----------------------------------------------------------

    /// The archive objects needed for `dates` (a JSON array of `YYYYMMDD`).
    #[wasm_bindgen(js_name = planRead)]
    pub fn plan_read(
        &self,
        feed_key: &str,
        dates: &str,
        archive_max: &str,
    ) -> Result<String, JsError> {
        let dates: Vec<u32> =
            serde_json::from_str(dates).map_err(|e| error(format!("Invalid dates: {e}")))?;
        let plan = plan::plan_read(
            feed_key,
            &dates,
            &self.clock,
            ServiceDate::parse(archive_max),
        )
        .map_err(error)?;
        Self::json(&plan)
    }

    /// Loads the archive's schedule catalog, once per run.
    #[wasm_bindgen(js_name = setScheduleCatalogs)]
    pub fn set_schedule_catalogs(&mut self, json: &str) -> Result<(), JsError> {
        self.catalogs = plan::parse_catalogs(json).map_err(error)?;
        Ok(())
    }

    /// The schedule in force on a date. `schedule_urls` is JSON.
    #[wasm_bindgen(js_name = chooseSchedule)]
    pub fn choose_schedule(&self, schedule_urls: &str, date: u32) -> Result<String, JsError> {
        let urls: Vec<String> = serde_json::from_str(schedule_urls)
            .map_err(|e| error(format!("Invalid schedule list: {e}")))?;
        Self::json(&plan::choose_schedule(
            &urls,
            &self.catalogs,
            ServiceDate(date),
        ))
    }

    #[wasm_bindgen(js_name = describeQuery)]
    pub fn describe_query(alias: &str) -> Result<String, JsError> {
        sql::describe_query(alias).map_err(error)
    }

    #[wasm_bindgen(js_name = feedMetadataQuery)]
    pub fn feed_metadata_query() -> String {
        sql::FEED_METADATA_QUERY.to_owned()
    }

    #[wasm_bindgen(js_name = longitudeQuery)]
    pub fn longitude_query(columns: &str, alias: &str) -> Result<String, JsError> {
        let columns: Vec<String> =
            serde_json::from_str(columns).map_err(|e| error(format!("Invalid columns: {e}")))?;
        sql::longitude_query(&columns, alias).map_err(error)
    }

    #[wasm_bindgen(js_name = fixesQuery)]
    pub fn fixes_query(
        columns: &str,
        alias: &str,
        start: f64,
        end: f64,
    ) -> Result<String, JsError> {
        let columns: Vec<String> =
            serde_json::from_str(columns).map_err(|e| error(format!("Invalid columns: {e}")))?;
        sql::fixes_query(&columns, alias, start as i64, end as i64).map_err(error)
    }

    #[wasm_bindgen(js_name = positionFixesQuery)]
    pub fn position_fixes_query(
        columns: &str,
        alias: &str,
        start: f64,
        end: f64,
    ) -> Result<String, JsError> {
        let columns: Vec<String> =
            serde_json::from_str(columns).map_err(|e| error(format!("Invalid columns: {e}")))?;
        sql::position_fixes_query(&columns, alias, start as i64, end as i64).map_err(error)
    }

    #[wasm_bindgen(js_name = scheduleQuery)]
    pub fn schedule_query(table: &str, columns: &str, alias: &str) -> Result<String, JsError> {
        let columns: Vec<String> =
            serde_json::from_str(columns).map_err(|e| error(format!("Invalid columns: {e}")))?;
        sql::schedule_query(table, &columns, alias).map_err(error)
    }
}
