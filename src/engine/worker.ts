// Runs everything heavy off the main thread: DuckDB reads Parquet from the
// public archive, and the Rust engine turns those rows into results. Nothing
// here talks to any server except the archive.
import init, {Engine} from '../../.build/pkg/transit_wasm.js';
import * as duckdb from '@duckdb/duckdb-wasm';
import duckWasm from '@duckdb/duckdb-wasm/dist/duckdb-base.wasm?url';
import duckWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-base.worker.js?url';
import {ARCHIVE, MAX_METADATA_BYTES, MAX_SCHEDULE_TABLE_BYTES, enforceObjectSize, validateArchiveURL} from './contracts.js';
import {
  clearCache, dayKey, getEntry, listDays, putEntry, scheduleKey,
  type DayEntry, type EventsEntry, type FeedEntry, type ScheduleEntry,
} from './cache';
import type {AnalyzeRequest, AnalyzeResult, EngineEvent, Feed, ReadRecord, ScheduleRecord} from './types';

const SCHEDULE_TABLES = ['agency', 'routes', 'stops', 'shapes', 'calendar', 'calendar_dates', 'trips', 'stop_times'] as const;

let engineReady: Promise<unknown> | undefined;
let engine: Engine | undefined;
let currentFeed: string | undefined;
let baseUrl = '';

let db: duckdb.AsyncDuckDB | undefined;
let duckWorkerInstance: Worker | undefined;
let connection: duckdb.AsyncDuckDBConnection | undefined;
let engineVersion: string | null = null;
let stopRequested = false;

const emit = (event: EngineEvent) => postMessage(event);

// ---- Network helpers -------------------------------------------------------

async function archiveFetch(url: string, options: RequestInit = {}, timeout = 30_000) {
  validateArchiveURL(url);
  return fetch(url, {...options, signal: AbortSignal.timeout(timeout), credentials: 'omit', referrerPolicy: 'no-referrer'});
}

async function archiveJson<T>(path: string): Promise<T> {
  const response = await archiveFetch(`${ARCHIVE}${path}`);
  if (!response.ok) throw new Error(`The archive's ${path} returned HTTP ${response.status}. Check your connection and try again.`);
  const text = await response.text();
  if (text.length > MAX_METADATA_BYTES) throw new Error(`The archive's ${path} is larger than expected.`);
  return JSON.parse(text) as T;
}

/** Object size, or `null` when it does not exist. Other failures are errors, not "no data". */
async function objectSize(url: string, label: string): Promise<number | null> {
  const response = await archiveFetch(url, {method: 'HEAD'});
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}. This is an access or network problem, not evidence of missing service.`);
  return Number(response.headers.get('content-length'));
}

// ---- DuckDB ----------------------------------------------------------------

async function ensureDatabase() {
  if (connection) return connection;
  if (!globalThis.WebAssembly) throw new Error('This browser needs WebAssembly. Try a current version of Chrome, Edge, Firefox or Safari.');
  emit({event: 'stage', message: 'Starting the local database', fraction: 0, dayIndex: 0, dayCount: 0});
  duckWorkerInstance = new Worker(duckWorker);
  db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), duckWorkerInstance);
  await db.instantiate(duckWasm);
  // Without these exact settings the pinned build refuses HTTP files. See docs/feasibility.md.
  await db.open({maximumThreads: 1, filesystem: {allowFullHTTPReads: false, forceFullHTTPReads: false, reliableHeadRequests: true}});
  connection = await db.connect();
  await connection.query("SET memory_limit = '768MB'; SET autoinstall_known_extensions = false; SET autoload_known_extensions = false; SET allow_unsigned_extensions = false; SET allow_community_extensions = false;");
  const repository = new URL('engine/extensions/', baseUrl).href;
  await connection.query(`SET custom_extension_repository = '${repository.replaceAll("'", "''")}'; INSTALL parquet; LOAD parquet; INSTALL icu; LOAD icu; SET TimeZone = 'UTC';`);
  const version = await connection.query('SELECT version() AS v');
  engineVersion = String(version.toArray()[0].v);
  return connection;
}

function resetDatabase() {
  duckWorkerInstance?.terminate();
  duckWorkerInstance = db = connection = undefined;
}

async function columnsOf(alias: string) {
  const conn = await ensureDatabase();
  const table = await conn.query(`DESCRIBE SELECT * FROM read_parquet('${alias}')`);
  return table.toArray().map(row => String(row.column_name));
}

/** Streams a query, handing each Arrow batch to `onBatch` without decoding values. */
async function stream(sql: string, onBatch: (batch: any) => void) {
  const conn = await ensureDatabase();
  const reader = await conn.send(sql);
  for await (const batch of reader) {
    onBatch(batch);
    if (stopRequested) {
      await conn.cancelSent().catch(() => {});
      break;
    }
  }
}

const textColumn = (batch: any, name: string) => {
  const data = batch.getChild(name).data[0];
  return [data.valueOffsets as Int32Array, data.values as Uint8Array] as const;
};
const numberColumn = (batch: any, name: string) => batch.getChild(name).data[0].values;

// ---- Schedules -------------------------------------------------------------

/** Rows from a small table, as plain objects. */
async function rowsOf(sql: string) {
  const conn = await ensureDatabase();
  return (await conn.query(sql)).toArray().map(row => row.toJSON()) as Record<string, any>[];
}

const flag = (value: unknown) => Number(value) === 1;
const text = (value: unknown) => (value === null || value === undefined ? '' : String(value));
const optional = (value: unknown) => (value === null || value === undefined ? undefined : Number(value));

/** Compiles the schedule tables into the engine. */
async function loadSchedule(feedKey: string, choice: ScheduleChoice, label: string) {
  if (!engine) throw new Error('The engine is not ready.');
  const key = choice.key;
  if (engine.isCompiled(key)) return;
  emit({event: 'stage', message: `Reading the ${label} schedule`, fraction: 0, dayIndex: 0, dayCount: 0});
  await ensureDatabase();
  engine.beginSchedule(key);
  let timezone: string | null = null;
  for (const base of choice.bases) {
    for (const table of SCHEDULE_TABLES) {
      const url = `${base}/${table}.parquet`;
      const size = await objectSize(url, `Schedule table ${table}`);
      if (size === null) continue;
      if (size > MAX_SCHEDULE_TABLE_BYTES) throw new Error(`Schedule table ${table} is larger than this app reads.`);
      const alias = `schedule_${table}.parquet`;
      await db!.registerFileURL(alias, validateArchiveURL(url), duckdb.DuckDBDataProtocol.HTTP, false);
      try {
        const columns = JSON.stringify(await columnsOf(alias));
        const sql = Engine.scheduleQuery(table, columns, alias);
        if (table === 'stop_times') {
          await stream(sql, batch => {
            const [tripOffsets, tripBytes] = textColumn(batch, 'trip_id');
            const [stopOffsets, stopBytes] = textColumn(batch, 'stop_id');
            const [arrivalOffsets, arrivalBytes] = textColumn(batch, 'arrival_time');
            const [departureOffsets, departureBytes] = textColumn(batch, 'departure_time');
            engine!.pushStopTimes(tripOffsets, tripBytes, stopOffsets, stopBytes, numberColumn(batch, 'stop_sequence'),
              arrivalOffsets, arrivalBytes, departureOffsets, departureBytes, numberColumn(batch, 'timepoint'));
          });
        } else if (table === 'shapes') {
          await stream(sql, batch => {
            const [shapeOffsets, shapeBytes] = textColumn(batch, 'shape_id');
            engine!.pushShapes(shapeOffsets, shapeBytes, numberColumn(batch, 'shape_pt_sequence'),
              numberColumn(batch, 'shape_pt_lat'), numberColumn(batch, 'shape_pt_lon'));
          });
        } else {
          for (const row of await rowsOf(sql)) {
            switch (table) {
              case 'agency': {
                const zone = text(row.agency_timezone);
                if (zone) {
                  engine.setTimezone(zone);
                  timezone ??= zone;
                }
                break;
              }
              case 'routes':
                engine.addRoute(text(row.route_id), text(row.route_short_name), text(row.route_long_name),
                  optional(row.route_type), text(row.route_color), text(row.route_text_color));
                break;
              case 'stops':
                engine.addStop(text(row.stop_id), text(row.stop_code), text(row.stop_name), Number(row.stop_lat), Number(row.stop_lon));
                break;
              case 'calendar':
                engine.addCalendar(text(row.service_id), flag(row.monday), flag(row.tuesday), flag(row.wednesday), flag(row.thursday),
                  flag(row.friday), flag(row.saturday), flag(row.sunday), Number(row.start_date), Number(row.end_date));
                break;
              case 'calendar_dates':
                engine.addCalendarDate(text(row.service_id), Number(row.date), Number(row.exception_type));
                break;
              case 'trips':
                engine.addTrip(text(row.trip_id), text(row.route_id), text(row.service_id), optional(row.direction_id),
                  text(row.shape_id) || undefined, text(row.trip_headsign));
                break;
            }
          }
        }
      } finally {
        await db!.dropFile(alias).catch(() => {});
      }
    }
  }
  emit({event: 'stage', message: `Placing stops on the ${label} route lines`, fraction: 0, dayIndex: 0, dayCount: 0});
  const meta = engine.finishSchedule();
  await putEntry('schedules', scheduleKey(feedKey, key), {meta} satisfies ScheduleEntry);
  const record: ScheduleRecord = {
    key, bases: choice.bases, retrieved: choice.retrieved, published_before: choice.published_before,
    timezone: timezone ?? engine.scheduleTimezone() ?? null, match_rate: null, warnings: JSON.parse(engine.scheduleWarnings()),
  };
  emit({event: 'schedule', record});
}

interface ScheduleChoice { key: string; bases: string[]; retrieved: string[]; published_before: boolean }

/** Reads the time zone cheaply when no schedule has been compiled yet. */
async function timezoneOf(choice: ScheduleChoice): Promise<string | null> {
  for (const base of choice.bases) {
    const alias = 'schedule_agency_tz.parquet';
    const url = `${base}/agency.parquet`;
    if ((await objectSize(url, 'Schedule agency table')) === null) continue;
    await ensureDatabase();
    await db!.registerFileURL(alias, validateArchiveURL(url), duckdb.DuckDBDataProtocol.HTTP, false);
    try {
      const rows = await rowsOf(`SELECT agency_timezone FROM read_parquet('${alias}') LIMIT 1`);
      const zone = text(rows[0]?.agency_timezone);
      if (zone) return zone;
    } finally {
      await db!.dropFile(alias).catch(() => {});
    }
  }
  return null;
}

/** Samples UTC offsets from the browser's own time zone database. */
function clockSamples(timezone: string, firstDate: number, lastDate: number) {
  const formatter = new Intl.DateTimeFormat('en-US', {timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric'});
  const utcOf = (date: number) => Date.UTC(Math.floor(date / 10000), Math.floor(date / 100) % 100 - 1, date % 100) / 1000;
  const samples: number[] = [];
  for (let t = utcOf(firstDate) - 2 * 86400; t <= utcOf(lastDate) + 3 * 86400; t += 3600) {
    const parts: Record<string, number> = {};
    for (const part of formatter.formatToParts(new Date(t * 1000))) {
      if (part.type !== 'literal') parts[part.type] = Number(part.value);
    }
    const local = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) / 1000;
    samples.push(t, local - t);
  }
  return new Float64Array(samples);
}

// ---- Analysis --------------------------------------------------------------

async function openFeed(feedKey: string) {
  if (currentFeed === feedKey && engine) return engine;
  engine?.free();
  engine = new Engine();
  currentFeed = feedKey;
  return engine;
}

/** Restores a cached day. Returns false when it must be recomputed. */
async function restoreDay(feedKey: string, date: number) {
  const version = Engine.metricVersion();
  const entry = await getEntry<DayEntry>('days', dayKey(feedKey, date, version));
  if (!entry) return false;
  if (!engine!.hasSchedule(entry.digest)) {
    const schedule = await getEntry<ScheduleEntry>('schedules', scheduleKey(feedKey, entry.digest));
    if (!schedule || !engine!.importSchedule(schedule.meta)) return false;
  }
  const events = await getEntry<EventsEntry>('events', dayKey(feedKey, date, version));
  return engine!.importDay(entry.cube, events?.events ?? undefined);
}

async function analyze(request: AnalyzeRequest): Promise<AnalyzeResult> {
  stopRequested = false;
  const {feedKey, dates, dateMax} = request;
  await openFeed(feedKey);
  const version = Engine.metricVersion();
  const result: AnalyzeResult = {analyzed: [], cached: [], skipped: [], stopped: false, engineVersion};

  const remaining: number[] = [];
  for (const date of [...dates].sort((a, b) => a - b)) {
    if (await restoreDay(feedKey, date)) {
      result.cached.push(date);
      emit({event: 'day', date, cached: true});
    } else {
      remaining.push(date);
    }
  }
  if (!remaining.length) return result;

  emit({event: 'stage', message: 'Looking up this feed in the archive', fraction: 0, dayIndex: 0, dayCount: remaining.length});
  await ensureDatabase();
  result.engineVersion = engineVersion;
  await db!.registerFileURL('feeds.parquet', `${ARCHIVE}feeds.parquet`, duckdb.DuckDBDataProtocol.HTTP, false);
  const statement = await connection!.prepare("SELECT schedule_urls, schedule_url, interval_seconds FROM read_parquet('feeds.parquet') WHERE base64url = ? AND feed_type = 'vehicle_positions'");
  const metadata = (await statement.query(feedKey)).toArray().map(row => row.toJSON());
  await statement.close();
  const row = metadata[0] ?? {};
  let scheduleUrls: string[] = [];
  try {
    scheduleUrls = row.schedule_urls ? JSON.parse(String(row.schedule_urls)) : [];
  } catch {
    scheduleUrls = [];
  }
  if (!scheduleUrls.length && row.schedule_url) scheduleUrls = [String(row.schedule_url)];
  const catalogs = await archiveJson<unknown[]>('schedules.json');
  const catalogsJson = JSON.stringify(catalogs);
  const urlsJson = JSON.stringify(scheduleUrls);

  const choices = new Map<number, ScheduleChoice>();
  const dayDates: number[] = [];
  for (const date of remaining) {
    const choice: ScheduleChoice | null = JSON.parse(Engine.chooseSchedule(urlsJson, catalogsJson, date));
    if (!choice) {
      result.skipped.push({date, reason: 'The archive has no schedule version covering this date, so speeds, on-time performance and headways cannot be calculated.'});
      continue;
    }
    choices.set(date, choice);
    dayDates.push(date);
  }
  if (!dayDates.length) return result;

  // Time zone first: service days can't be located in UTC files without it.
  const cachedFeed = await getEntry<FeedEntry>('feeds', feedKey);
  let timezone = cachedFeed?.timezone ?? null;
  timezone ??= await timezoneOf(choices.get(dayDates[0])!);
  if (!timezone) throw new Error('This schedule does not state a time zone, so its service days cannot be located.');
  await putEntry('feeds', feedKey, {timezone} satisfies FeedEntry);
  engine!.setClock(clockSamples(timezone, dayDates[0], dayDates[dayDates.length - 1]));

  const plan: {files: any[]} = JSON.parse(engine!.planRead(feedKey, JSON.stringify(dayDates), dateMax));
  engine!.clearBuffer();
  const totalFiles = plan.files.length;
  let completedDays = 0;

  for (const [fileIndex, file] of plan.files.entries()) {
    if (stopRequested) break;
    const started = performance.now();
    const label = `${file.utc_date}`;
    const dayIndex = completedDays + 1;
    const progress = (within: number) => (fileIndex + within) / totalFiles;
    emit({event: 'stage', message: `Checking the ${label} archive file`, fraction: progress(0), dayIndex, dayCount: dayDates.length});
    const size = await objectSize(file.url, `Archive ${label}`);
    const record: ReadRecord = {date: file.utc_date, url: file.url, bytes: size ?? 0, status: size === null ? 'missing' : 'read', rows: 0, seconds: 0, sql: ''};
    if (size !== null) {
      enforceObjectSize(size, `Archive ${label}`);
      await db!.registerFileURL(file.alias, validateArchiveURL(file.url), duckdb.DuckDBDataProtocol.HTTP, false);
      try {
        const columns = await columnsOf(file.alias);
        const sql = Engine.fixesQuery(JSON.stringify(columns), file.alias, file.window_start, file.window_end);
        record.sql = sql;
        let lastReport = 0;
        await stream(sql, batch => {
          const fetch = numberColumn(batch, 'fetch') as Float64Array;
          const [tripOffsets, tripBytes] = textColumn(batch, 'trip_id');
          const [vehicleOffsets, vehicleBytes] = textColumn(batch, 'vehicle_id');
          const [routeOffsets, routeBytes] = textColumn(batch, 'route_id');
          const [dateOffsets, dateBytes] = textColumn(batch, 'start_date');
          const [timeOffsets, timeBytes] = textColumn(batch, 'start_time');
          engine!.pushFixes(fetch, numberColumn(batch, 'timestamp'), numberColumn(batch, 'latitude'), numberColumn(batch, 'longitude'),
            numberColumn(batch, 'occupancy_status'), numberColumn(batch, 'differential'),
            tripOffsets, tripBytes, vehicleOffsets, vehicleBytes, routeOffsets, routeBytes, dateOffsets, dateBytes, timeOffsets, timeBytes);
          record.rows += fetch.length;
          const now = performance.now();
          if (now - lastReport > 250 && fetch.length) {
            lastReport = now;
            // Files are written in time order, so the clock shows how far along we are.
            const within = Math.min(1, Math.max(0, (fetch[fetch.length - 1] - file.window_start) / (file.window_end - file.window_start)));
            emit({event: 'stage', message: `Reading ${label} from the archive`, fraction: progress(within), dayIndex, dayCount: dayDates.length});
          }
        });
      } finally {
        await db!.dropFile(file.alias).catch(() => {});
      }
    }
    record.seconds = (performance.now() - started) / 1000;
    emit({event: 'read', record});
    if (stopRequested) break;

    for (const date of file.completes as number[]) {
      const choice = choices.get(date);
      if (!choice) continue;
      await loadSchedule(feedKey, choice, formatDate(date));
      emit({event: 'stage', message: `Analysing ${formatDate(date)}`, fraction: progress(1), dayIndex, dayCount: dayDates.length});
      const match = engine!.tripMatchRate(choice.key);
      if (engine!.fixCount() > 0 && match < 0.5) {
        emit({event: 'warning', message: `Only ${(match * 100).toFixed(0)}% of realtime trip IDs on ${formatDate(date)} match the schedule, so most trips can't be measured. This agency's realtime and schedule feeds appear to use different IDs.`});
      }
      const output = engine!.processDay(date, choice.key, file.ends_at) as {cube: Uint8Array; events: Uint8Array};
      await putEntry('days', dayKey(feedKey, date, version), {cube: output.cube, digest: choice.key, savedAt: new Date().toISOString()} satisfies DayEntry);
      await putEntry('events', dayKey(feedKey, date, version), {events: output.events} satisfies EventsEntry);
      result.analyzed.push(date);
      completedDays += 1;
      emit({event: 'day', date, cached: false});
      const origin = engine!.serviceOrigin(date);
      const next = dayDates[dayDates.indexOf(date) + 1];
      const nextOrigin = next ? engine!.serviceOrigin(next) : undefined;
      if (nextOrigin !== undefined && origin !== undefined) engine!.evictBefore(nextOrigin);
    }
  }
  engine!.clearBuffer();
  result.stopped = stopRequested;
  return result;
}

function formatDate(date: number) {
  return `${Math.floor(date / 10000)}-${String(Math.floor(date / 100) % 100).padStart(2, '0')}-${String(date % 100).padStart(2, '0')}`;
}

// ---- Messages --------------------------------------------------------------

const methods: Record<string, (...args: any[]) => unknown> = {
  async init(url: string) {
    baseUrl = url;
    engineReady ??= init();
    await engineReady;
    return true;
  },
  async catalog() {
    const data = await archiveJson<Feed[]>('inventory.json');
    if (!Array.isArray(data) || data.length > 5000) throw new Error('The archive catalog has an unexpected shape.');
    return data;
  },
  analyze,
  stop() {
    stopRequested = true;
    resetDatabase();
    return true;
  },
  async cachedDays(feedKey: string) {
    return listDays(feedKey, Engine.metricVersion());
  },
  async clearCache(feedKey?: string) {
    await clearCache(feedKey);
    if (!feedKey || feedKey === currentFeed) {
      engine?.free();
      engine = undefined;
      currentFeed = undefined;
    }
    return true;
  },
  async openFeed(feedKey: string) {
    await openFeed(feedKey);
    return true;
  },
  select(selection: string) {
    engine?.select(selection);
    return true;
  },
  overview: () => JSON.parse(engine!.overview()),
  routes: () => JSON.parse(engine!.routes()),
  networkMap: (route?: string) => JSON.parse(engine!.networkMap(route)),
  hotspots: () => JSON.parse(engine!.hotspots()),
  routeDetail: (route: string) => JSON.parse(engine!.routeDetail(route)),
  async stringLine(route: string, dir: number, date: number) {
    if (!engine!.hasEvents(date) && currentFeed) {
      const entry = await getEntry<EventsEntry>('events', dayKey(currentFeed, date, Engine.metricVersion()));
      if (entry) engine!.importEvents(date, entry.events);
    }
    return JSON.parse(engine!.stringLine(route, dir, date));
  },
  stops: () => JSON.parse(engine!.stops()),
  quality: () => JSON.parse(engine!.quality()),
  async sql(text: string) {
    const conn = await ensureDatabase();
    const table = await conn.query(text);
    return {
      columns: table.schema.fields.map(field => field.name),
      rows: table.toArray().slice(0, 2000).map(row => row.toArray().map((value: unknown) => (typeof value === 'bigint' ? Number(value) : value))),
    };
  },
};

addEventListener('message', async (event: MessageEvent) => {
  const {id, method, args} = event.data;
  try {
    const fn = methods[method];
    if (!fn) throw new Error(`Unknown engine method ${method}`);
    postMessage({id, result: await fn(...args)});
  } catch (error) {
    postMessage({id, error: error instanceof Error ? error.message : String(error)});
  }
});
