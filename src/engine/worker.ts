// Runs everything heavy off the main thread: DuckDB reads Parquet from the
// public archive, and the Rust engine turns those rows into results. Nothing
// here talks to any server except the archive.
import init, {Engine} from '../../.build/pkg/transit_wasm.js';
import * as duckdb from '@duckdb/duckdb-wasm';
import duckWasm from '@duckdb/duckdb-wasm/dist/duckdb-base.wasm?url';
import duckWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-base.worker.js?url';
import {ARCHIVE, MAX_METADATA_BYTES, MAX_SCHEDULE_TABLE_BYTES, enforceObjectSize, validateArchiveURL} from './contracts.js';
import {
  clearCache, dayKey, deleteEntry, getEntry, listDays, onCacheProblem, putEntry, scheduleKey,
  type DayEntry, type DayIndexEntry, type EventsEntry, type FeedEntry, type ScheduleEntry,
} from './cache';
import {EngineError, classifyError, isTransient, serializeError} from './errors';
import {withTripMatch} from './tripmatch';
import type {AnalyzeRequest, AnalyzeResult, EngineEvent, Feed, ReadRecord, ScheduleRecord, TimingSpan} from './types';

/**
 * Below this share of matching trip IDs the feed and schedule don't belong together,
 * so the day falls back to GPS speeds. It is low on purpose: a feed shared by several
 * agencies matches well under half its trips and still measures its own perfectly.
 */
const MIN_TRIP_MATCH = 0.1;
const NOTE_TRIP_MATCH = 0.8;
/** Objects up to this size are downloaded whole, ahead of need. Larger ones are read in place, where row-group pushdown skips most of them. */
const PREFETCH_MAX_BYTES = 96 * 1024 * 1024;
const PREFETCH_CHUNK_BYTES = 8 * 1024 * 1024;
const PREFETCH_STREAMS = 6;
const SCHEDULE_TABLES = ['agency', 'routes', 'stops', 'shapes', 'calendar', 'calendar_dates', 'trips', 'stop_times'] as const;
const REQUIRED_TABLES = new Set<string>(['routes', 'stops', 'trips', 'stop_times']);
/** Stop events for this many days stay in memory. The rest are read back on demand. */
const EVENT_DAYS_IN_MEMORY = 3;

let engineReady: Promise<unknown> | undefined;
let engine: Engine | undefined;
let currentFeed: string | undefined;
let baseUrl = '';
let eventDatesInMemory: number[] = [];
/** Share of realtime trip IDs matching the schedule for each day of the open feed, 0 to 1. */
let tripMatches = new Map<number, number | null>();

let db: duckdb.AsyncDuckDB | undefined;
let duckWorkerInstance: Worker | undefined;
let connection: duckdb.AsyncDuckDBConnection | undefined;
let databaseSetup: Promise<duckdb.AsyncDuckDBConnection> | undefined;
let engineVersion: string | null = null;

/** Thrown out of any wait once a run has been stopped. */
class RunStopped extends EngineError {
  constructor() {
    super('cancelled', 'The analysis was stopped.');
  }
}

/** Cache trouble is reported once per session, outside any run. */
onCacheProblem(message => postMessage({event: 'cache', message, run: 0}));

/**
 * One analysis. It owns everything it touches, so a stopped run can't write into the
 * run after it or into another agency's results. DuckDB never settles calls in flight
 * when its worker is terminated, so each wait races against `stopped` to unwind at once.
 */
class Run {
  cancelled = false;
  readonly stopped: Promise<never>;
  readonly settled: Promise<void>;
  finish!: () => void;
  private rejectStopped!: (reason: RunStopped) => void;

  constructor(readonly id: number, readonly feedKey: string, readonly engine: Engine) {
    this.stopped = new Promise<never>((_, reject) => (this.rejectStopped = reject));
    this.stopped.catch(() => {});
    this.settled = new Promise<void>(resolve => (this.finish = resolve));
  }

  /** Aborts this run's own downloads, which DuckDB's terminated worker would not take down. */
  readonly abort = new AbortController();
  /** Schedules being fetched ahead of need, by schedule key. */
  readonly scheduleTables = new Map<string, Map<string, Promise<File | null>>>();

  cancel() {
    this.cancelled = true;
    this.abort.abort();
    this.rejectStopped(new RunStopped());
  }

  wait<T>(promise: Promise<T>): Promise<T> {
    if (this.cancelled) return Promise.reject(new RunStopped());
    return Promise.race([promise, this.stopped]);
  }

  emit(event: EngineEvent) {
    if (!this.cancelled) postMessage({...event, run: this.id});
  }

  /** Where the time goes, in milliseconds from the start of the run. Spans may overlap. */
  readonly spans: TimingSpan[] = [];
  readonly origin = performance.now();

  /** Times `work` under `name`, also leaving a performance measure for the browser's profiler. */
  async span<T>(name: string, work: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      return await work();
    } finally {
      const ended = performance.now();
      this.spans.push({name, start: Math.round(started - this.origin), end: Math.round(ended - this.origin)});
      try { performance.measure(name, {start: started, end: ended}); } catch { /* profiling only */ }
    }
  }

  /** What the run is doing now, kept for error reports. */
  where = 'starting';
  private last = {fraction: 0, dayIndex: 0, dayCount: 0};

  /**
   * Reports a stage. Anything left out keeps its last value, and the fraction can only
   * grow, so stages that don't know their share (the schedule, the database) never pull
   * the bar back to zero.
   */
  stage(message: string, fraction?: number, dayIndex?: number, dayCount?: number, extra: StageExtra = {}) {
    this.where = message;
    this.last = {
      fraction: Math.max(this.last.fraction, fraction ?? 0),
      dayIndex: Math.max(this.last.dayIndex, dayIndex ?? 0),
      dayCount: dayCount || this.last.dayCount,
    };
    this.emit({event: 'stage', message, ...this.last, ...extra});
  }
}

type StageExtra = Partial<Pick<Extract<EngineEvent, {event: 'stage'}>, 'phase' | 'bytesDone' | 'bytesTotal' | 'date'>>;

let activeRun: Run | undefined;

async function stopActiveRun() {
  const run = activeRun;
  if (!run) return;
  run.cancel();
  resetDatabase();
  await run.settled;
}

// ---- Network helpers -------------------------------------------------------

async function archiveFetch(url: string, options: RequestInit = {}, timeout = 30_000) {
  validateArchiveURL(url);
  return fetch(url, {...options, signal: AbortSignal.timeout(timeout), credentials: 'omit', referrerPolicy: 'no-referrer'});
}

/**
 * The archive's small JSON files, kept for a few minutes so a second analysis or a
 * retry doesn't ask again. After that the browser revalidates with the file's ETag,
 * which costs a header exchange and no body when nothing changed. A failure is never kept.
 */
const JSON_FRESH_MS = 5 * 60_000;
const jsonCache = new Map<string, {at: number; value: Promise<unknown>}>();

function archiveJson<T>(path: string, timeout = 30_000): Promise<T> {
  const kept = jsonCache.get(path);
  if (kept && Date.now() - kept.at < JSON_FRESH_MS) return kept.value as Promise<T>;
  const value = (async () => {
    const response = await archiveFetch(`${ARCHIVE}${path}`, {cache: 'no-cache'}, timeout);
    if (!response.ok) throw new Error(`The archive's ${path} returned HTTP ${response.status}. Check your connection and try again.`);
    const text = await response.text();
    if (text.length > MAX_METADATA_BYTES) throw new Error(`The archive's ${path} is larger than expected.`);
    return JSON.parse(text) as T;
  })();
  jsonCache.set(path, {at: Date.now(), value});
  value.catch(() => {
    if (jsonCache.get(path)?.value === value) jsonCache.delete(path);
  });
  return value;
}

/**
 * Fetches a whole object into a File, which DuckDB then reads without any network.
 * Null when it does not exist. Anything else that goes wrong is an error, never "no data".
 */
async function fetchWhole(run: Run, url: string, label: string, maxBytes: number): Promise<File | null> {
  validateArchiveURL(url);
  const response = await fetch(url, {signal: AbortSignal.any([run.abort.signal, AbortSignal.timeout(90_000)]), credentials: 'omit', referrerPolicy: 'no-referrer'});
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}. This is an access or network problem, not evidence of missing service.`);
  const length = Number(response.headers.get('content-length'));
  if (length > maxBytes) {
    await response.body?.cancel();
    throw new Error(`${label} is larger than this app reads.`);
  }
  return new File([await response.blob()], url.split('/').pop() || 'object.parquet');
}

/** Object size, or `null` when it does not exist. Other failures are errors, not "no data". */
async function objectSize(url: string, label: string): Promise<number | null> {
  const response = await archiveFetch(url, {method: 'HEAD'});
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}. This is an access or network problem, not evidence of missing service.`);
  return Number(response.headers.get('content-length'));
}

// ---- DuckDB ----------------------------------------------------------------

async function openDatabase() {
  if (!globalThis.WebAssembly) throw new Error('This browser needs WebAssembly. Try a current version of Chrome, Edge, Firefox or Safari.');
  const instance = new Worker(duckWorker);
  duckWorkerInstance = instance;
  const opened = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), instance);
  db = opened;
  await opened.instantiate(duckWasm);
  // Without these exact settings the pinned build refuses HTTP files. See docs/feasibility.md.
  await opened.open({maximumThreads: 1, filesystem: {allowFullHTTPReads: false, forceFullHTTPReads: false, reliableHeadRequests: true}});
  const conn = await opened.connect();
  await conn.query("SET memory_limit = '768MB'; SET autoinstall_known_extensions = false; SET autoload_known_extensions = false; SET allow_unsigned_extensions = false; SET allow_community_extensions = false;");
  const repository = new URL('engine/extensions/', baseUrl).href;
  await conn.query(`SET custom_extension_repository = '${repository.replaceAll("'", "''")}'; INSTALL parquet; LOAD parquet; INSTALL icu; LOAD icu; SET TimeZone = 'UTC';`);
  const version = await conn.query('SELECT version() AS v');
  engineVersion = String(version.toArray()[0].v);
  connection = conn;
  return conn;
}

/** Starts the database once. A failed start is thrown away, so the next try is clean. */
function ensureDatabase() {
  databaseSetup ??= openDatabase().catch(error => {
    resetDatabase();
    throw error;
  });
  return databaseSetup;
}

function resetDatabase() {
  duckWorkerInstance?.terminate();
  duckWorkerInstance = db = connection = databaseSetup = undefined;
}

async function columnsOf(run: Run, alias: string) {
  const conn = await run.wait(ensureDatabase());
  const table = await run.wait(conn.query(Engine.describeQuery(alias)));
  return table.toArray().map(row => String(row.column_name));
}

/** Streams a query, handing each Arrow batch to `onBatch` without decoding values. */
async function stream(run: Run, sql: string, onBatch: (batch: any) => void) {
  const conn = await run.wait(ensureDatabase());
  const reading = (async () => {
    // True asks DuckDB not to materialize the whole result, which keeps memory down
    // and lets progress move while the file is actually being read.
    const reader = await conn.send(sql, true);
    for await (const batch of reader) {
      if (run.cancelled) return;
      onBatch(batch);
    }
  })();
  await run.wait(reading);
}

const textColumn = (batch: any, name: string) => {
  const data = batch.getChild(name).data[0];
  return [data.valueOffsets as Int32Array, data.values as Uint8Array] as const;
};
const numberColumn = (batch: any, name: string) => batch.getChild(name).data[0].values;

/**
 * Downloads an object in parallel ranges into a File that DuckDB reads without any
 * network. DuckDB's own reads are one synchronous request at a time, ramping from 16 KB,
 * so a 34 MB object costs about 28 round trips; a handful of parallel ranges fetches
 * the same bytes in a few. `onBytes` hears each range as it lands.
 */
async function downloadObject(run: Run, url: string, size: number, onBytes: (bytes: number) => void): Promise<File> {
  validateArchiveURL(url);
  const ranges: [number, number][] = [];
  for (let start = 0; start < size; start += PREFETCH_CHUNK_BYTES) ranges.push([start, Math.min(size, start + PREFETCH_CHUNK_BYTES) - 1]);
  const parts: Blob[] = new Array(ranges.length);
  let next = 0;
  const worker = async () => {
    while (next < ranges.length && !run.cancelled) {
      const index = next++;
      const [first, last] = ranges[index];
      const response = await fetch(url, {
        headers: {Range: `bytes=${first}-${last}`},
        signal: AbortSignal.any([run.abort.signal, AbortSignal.timeout(90_000)]),
        credentials: 'omit', referrerPolicy: 'no-referrer',
      });
      if (!response.ok) throw new Error(`Archive ${url.split('/').slice(-3)[0]} returned HTTP ${response.status}. This is an access or network problem, not evidence of missing service.`);
      const blob = await response.blob();
      if (blob.size !== last - first + 1) throw new Error(`The archive returned ${blob.size} bytes for a range of ${last - first + 1}.`);
      parts[index] = blob;
      onBytes(blob.size);
    }
  };
  await Promise.all(Array.from({length: Math.min(PREFETCH_STREAMS, ranges.length)}, worker));
  return new File(parts, 'data.parquet');
}

/** Registers a file already held in memory for the length of `use`. */
async function withLocalFile<T>(run: Run, alias: string, file: File, use: () => Promise<T>) {
  await run.wait(ensureDatabase());
  await run.wait(db!.registerFileHandle(alias, file, duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true));
  try {
    return await use();
  } finally {
    if (!run.cancelled) await db?.dropFile(alias).catch(() => {});
  }
}

/** Registers an archive file for the length of `use`. */
async function withFile<T>(run: Run, alias: string, url: string, use: () => Promise<T>) {
  await run.wait(ensureDatabase());
  await run.wait(db!.registerFileURL(alias, validateArchiveURL(url), duckdb.DuckDBDataProtocol.HTTP, false));
  try {
    return await use();
  } finally {
    // A stopped database never answers this, and has already gone away.
    if (!run.cancelled) await db?.dropFile(alias).catch(() => {});
  }
}

// ---- Schedules -------------------------------------------------------------

interface ScheduleChoice { key: string; bases: string[]; retrieved: string[]; published_before: boolean }

/** A schedule table already fetched whole, or null when the archive has none. */
type ScheduleTables = Map<string, Promise<File | null>>;

/**
 * Starts fetching every table of a schedule at once, without waiting for DuckDB. The
 * tables are small, so one plain GET each replaces what DuckDB would otherwise do in
 * a strict sequence of HEAD, footer read, and query per table. The fetches run while
 * the first archive file is being read, and DuckDB then reads the tables from memory.
 * A failure waits inside its promise until the table is needed, so it is reported then.
 */
function prefetchSchedule(run: Run, choice: ScheduleChoice): ScheduleTables {
  const existing = run.scheduleTables.get(choice.key);
  if (existing) return existing;
  const tables: ScheduleTables = new Map();
  for (const base of choice.bases) {
    for (const table of SCHEDULE_TABLES) {
      const url = `${base}/${table}.parquet`;
      const fetched = run.span(`schedule ${table} fetch`, () => fetchWhole(run, url, `Schedule table ${table}`, MAX_SCHEDULE_TABLE_BYTES));
      fetched.catch(() => {});
      tables.set(url, fetched);
    }
  }
  run.scheduleTables.set(choice.key, tables);
  return tables;
}

/** One short query as plain objects. For anything long, read Arrow columns instead. */
async function rowsOf(run: Run, sql: string) {
  const conn = await run.wait(ensureDatabase());
  return (await run.wait(conn.query(sql))).toArray().map(row => row.toJSON()) as Record<string, any>[];
}

const flag = (value: unknown) => Number(value) === 1;
const text = (value: unknown) => (value === null || value === undefined ? '' : String(value));
const optional = (value: unknown) => (value === null || value === undefined ? undefined : Number(value));

/** A small table as Arrow columns, read by position instead of turned into an object per row. */
async function tableOf(run: Run, sql: string) {
  const conn = await run.wait(ensureDatabase());
  const result = await run.wait(conn.query(sql));
  const column = (name: string) => result.getChild(name)!;
  return {rows: result.numRows, column};
}

/** Compiles the schedule tables into the engine. */
async function loadSchedule(run: Run, choice: ScheduleChoice, label: string) {
  const {engine: target} = run;
  const key = choice.key;
  if (target.isCompiled(key)) return;
  run.stage(`Reading the ${label} schedule`, undefined, undefined, undefined, {phase: 'schedule'});
  const tables = prefetchSchedule(run, choice);
  target.beginSchedule(key);
  let timezone: string | null = null;
  for (const base of choice.bases) {
    for (const table of SCHEDULE_TABLES) {
      const url = `${base}/${table}.parquet`;
      const file = await run.wait(tables.get(url)!);
      if (file === null) {
        if (REQUIRED_TABLES.has(table)) target.addScheduleWarning(`One of this agency's schedule sources has no ${table} table, so its trips are left out.`);
        continue;
      }
      const alias = `schedule_${table}.parquet`;
      await run.span(`schedule ${table}`, () => withLocalFile(run, alias, file, async () => {
        const columns = JSON.stringify(await run.span(`schedule ${table} describe`, () => columnsOf(run, alias)));
        const sql = Engine.scheduleQuery(table, columns, alias);
        if (table === 'stop_times') {
          await stream(run, sql, batch => {
            const [tripOffsets, tripBytes] = textColumn(batch, 'trip_id');
            const [stopOffsets, stopBytes] = textColumn(batch, 'stop_id');
            const [arrivalOffsets, arrivalBytes] = textColumn(batch, 'arrival_time');
            const [departureOffsets, departureBytes] = textColumn(batch, 'departure_time');
            target.pushStopTimes(tripOffsets, tripBytes, stopOffsets, stopBytes, numberColumn(batch, 'stop_sequence'),
              arrivalOffsets, arrivalBytes, departureOffsets, departureBytes, numberColumn(batch, 'timepoint'));
          });
        } else if (table === 'shapes') {
          await stream(run, sql, batch => {
            const [shapeOffsets, shapeBytes] = textColumn(batch, 'shape_id');
            target.pushShapes(shapeOffsets, shapeBytes, numberColumn(batch, 'shape_pt_sequence'),
              numberColumn(batch, 'shape_pt_lat'), numberColumn(batch, 'shape_pt_lon'));
          });
        } else {
          const {rows, column} = await tableOf(run, sql);
          switch (table) {
            case 'agency': {
              const zones = column('agency_timezone');
              for (let i = 0; i < rows; i++) {
                const zone = text(zones.get(i));
                if (zone) {
                  target.setTimezone(zone);
                  timezone ??= zone;
                }
              }
              break;
            }
            case 'routes': {
              const id = column('route_id'), short = column('route_short_name'), long = column('route_long_name');
              const type = column('route_type'), color = column('route_color'), textColor = column('route_text_color');
              for (let i = 0; i < rows; i++) {
                target.addRoute(text(id.get(i)), text(short.get(i)), text(long.get(i)), optional(type.get(i)), text(color.get(i)), text(textColor.get(i)));
              }
              break;
            }
            case 'stops': {
              const id = column('stop_id'), code = column('stop_code'), name = column('stop_name');
              const lat = column('stop_lat'), lon = column('stop_lon');
              for (let i = 0; i < rows; i++) {
                target.addStop(text(id.get(i)), text(code.get(i)), text(name.get(i)), Number(lat.get(i)), Number(lon.get(i)));
              }
              break;
            }
            case 'calendar': {
              const id = column('service_id'), start = column('start_date'), end = column('end_date');
              const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map(column);
              for (let i = 0; i < rows; i++) {
                target.addCalendar(text(id.get(i)), flag(days[0].get(i)), flag(days[1].get(i)), flag(days[2].get(i)), flag(days[3].get(i)),
                  flag(days[4].get(i)), flag(days[5].get(i)), flag(days[6].get(i)), Number(start.get(i)), Number(end.get(i)));
              }
              break;
            }
            case 'calendar_dates': {
              const id = column('service_id'), date = column('date'), type = column('exception_type');
              for (let i = 0; i < rows; i++) target.addCalendarDate(text(id.get(i)), Number(date.get(i)), Number(type.get(i)));
              break;
            }
            case 'trips': {
              const id = column('trip_id'), route = column('route_id'), service = column('service_id');
              const direction = column('direction_id'), shape = column('shape_id'), headsign = column('trip_headsign');
              for (let i = 0; i < rows; i++) {
                target.addTrip(text(id.get(i)), text(route.get(i)), text(service.get(i)), optional(direction.get(i)),
                  text(shape.get(i)) || undefined, text(headsign.get(i)));
              }
              break;
            }
          }
        }
      }));
    }
  }
  run.stage(`Placing stops on the ${label} route lines`, undefined, undefined, undefined, {phase: 'schedule'});
  const meta = target.finishSchedule();
  await run.wait(putEntry('schedules', scheduleKey(run.feedKey, key), {meta} satisfies ScheduleEntry));
  const record: ScheduleRecord = {
    key, bases: choice.bases, retrieved: choice.retrieved, published_before: choice.published_before,
    timezone: timezone ?? target.scheduleTimezone() ?? null, warnings: JSON.parse(target.scheduleWarnings()),
  };
  run.scheduleTables.delete(key);
  run.emit({event: 'schedule', record});
}

/** Reads the time zone from the schedule's agency table, fetched once and shared with `loadSchedule`. */
async function timezoneOf(run: Run, choice: ScheduleChoice): Promise<string | null> {
  const tables = prefetchSchedule(run, choice);
  for (const base of choice.bases) {
    const file = await run.wait(tables.get(`${base}/agency.parquet`)!);
    if (file === null) continue;
    const alias = 'schedule_agency_tz.parquet';
    const zone = await withLocalFile(run, alias, file, async () => {
      const columns = JSON.stringify(await columnsOf(run, alias));
      const {rows, column} = await tableOf(run, Engine.scheduleQuery('agency', columns, alias));
      return rows ? text(column('agency_timezone').get(0)) : '';
    });
    if (zone) return zone;
  }
  return null;
}

/**
 * A rough zone from where vehicles are, for feeds with no schedule to state one. The
 * archive covers the United States, so longitude bands are close enough, and the app
 * says when it has done this. It can be wrong in Arizona, Alaska and Hawaii.
 */
async function timezoneFromPositions(run: Run, date: number) {
  const iso = formatDate(date);
  const url = `${ARCHIVE}vehicle_positions/date=${iso}/base64url=${run.feedKey}/data.parquet`;
  if ((await run.wait(objectSize(url, `Archive ${iso}`))) === null) return null;
  const alias = 'timezone_probe.parquet';
  return withFile(run, alias, url, async () => {
    const columns = JSON.stringify(await columnsOf(run, alias));
    const rows = await rowsOf(run, Engine.longitudeQuery(columns, alias));
    const longitude = Number(rows[0]?.longitude);
    if (!Number.isFinite(longitude)) return null;
    if (longitude > -85.5) return 'America/New_York';
    if (longitude > -101) return 'America/Chicago';
    if (longitude > -115) return 'America/Denver';
    return 'America/Los_Angeles';
  });
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

function openFeedEngine(feedKey: string) {
  if (currentFeed === feedKey && engine) return engine;
  engine?.free();
  engine = new Engine();
  currentFeed = feedKey;
  eventDatesInMemory = [];
  tripMatches = new Map();
  return engine;
}

/** Restores a cached day. Returns false when it has to be analysed again. */
async function restoreDay(run: Run, date: number) {
  const version = Engine.metricVersion();
  const key = dayKey(run.feedKey, date, version);
  const entry = await run.wait(getEntry<DayEntry>('days', key));
  if (!entry) return false;
  try {
    if (!run.engine.hasSchedule(entry.digest)) {
      const schedule = await run.wait(getEntry<ScheduleEntry>('schedules', scheduleKey(run.feedKey, entry.digest)));
      if (!schedule || !run.engine.importSchedule(schedule.meta)) return false;
    }
    // Stop events load on demand, because most days are never drawn as a string line.
    const imported = run.engine.importDay(entry.cube);
    // Days saved before the rate was kept have none, and are read from their notes.
    if (imported && entry.tripMatch !== undefined) tripMatches.set(date, entry.tripMatch);
    else tripMatches.delete(date);
    return imported;
  } catch (error) {
    if (error instanceof RunStopped) throw error;
    console.warn(`[cache] saved results for ${formatDate(date)} were unreadable and will be removed`, error);
    // Unreadable results are worth nothing, so remove them and analyse the day again.
    await Promise.all([deleteEntry('days', key), deleteEntry('events', key), deleteEntry('dayIndex', key)]);
    run.emit({event: 'warning', message: `The saved results for ${formatDate(date)} couldn't be read and were removed. Analyzing that day again.`});
    return false;
  }
}

/**
 * Saves a finished day, last of all writing the entry that makes it visible, so a
 * partly saved day can never be restored as if it were whole.
 */
async function saveDay(run: Run, date: number, digest: string, cube: Uint8Array, events: Uint8Array | null, tripMatch: number | null) {
  const version = Engine.metricVersion();
  const key = dayKey(run.feedKey, date, version);
  if (events && !(await run.wait(putEntry('events', key, {events} satisfies EventsEntry)))) return false;
  if (!(await run.wait(putEntry('days', key, {cube, digest, savedAt: new Date().toISOString(), tripMatch} satisfies DayEntry)))) return false;
  return run.wait(putEntry('dayIndex', key, {bytes: cube.byteLength} satisfies DayIndexEntry));
}

function rememberEvents(date: number) {
  eventDatesInMemory = [...eventDatesInMemory.filter(d => d !== date), date];
  while (eventDatesInMemory.length > EVENT_DAYS_IN_MEMORY) {
    engine?.dropEvents(eventDatesInMemory.shift()!);
  }
}

async function execute(run: Run, request: AnalyzeRequest, result: AnalyzeResult) {
  const {dates, dateMax} = request;
  const target = run.engine;

  const remaining: number[] = [];
  for (const date of [...new Set(dates)].sort((a, b) => a - b)) {
    if (await restoreDay(run, date)) {
      result.cached.push(date);
      run.emit({event: 'day', date, cached: true});
    } else {
      remaining.push(date);
    }
  }
  if (!remaining.length) return;

  const notes: string[] = [];
  // The schedule catalog needs no database, so it is fetched while the database starts.
  const catalogs = run.span('schedules.json', () => archiveJson<unknown[]>('schedules.json').then(data => JSON.stringify(data)));
  catalogs.catch(() => {});
  run.stage('Starting the local database', 0, 0, remaining.length, {phase: 'database'});
  await run.span('database', () => run.wait(ensureDatabase()));
  result.engineVersion = engineVersion;

  run.stage('Looking up this feed in the archive', 0, 0, remaining.length, {phase: 'lookup'});
  const metadata = await run.span('feeds.parquet', () => withFile(run, 'feeds.parquet', `${ARCHIVE}feeds.parquet`, async () => {
    const statement = await run.wait(connection!.prepare(Engine.feedMetadataQuery()));
    const rows = (await run.wait(statement.query(run.feedKey))).toArray().map(row => row.toJSON());
    await run.wait(statement.close());
    return rows;
  }));
  const row = metadata[0] ?? {};
  let scheduleUrls: string[] = [];
  try {
    scheduleUrls = row.schedule_urls ? JSON.parse(String(row.schedule_urls)) : [];
  } catch {
    notes.push("The archive's list of schedules for this feed couldn't be read.");
  }
  if (!scheduleUrls.length && row.schedule_url) scheduleUrls = [String(row.schedule_url)];
  target.setScheduleCatalogs(await run.wait(catalogs));
  const urlsJson = JSON.stringify(scheduleUrls);

  // A day with no covering schedule still gets GPS speeds. Only the time zone has
  // to come from somewhere else.
  const choices = new Map<number, ScheduleChoice>();
  for (const date of remaining) {
    const choice: ScheduleChoice | null = JSON.parse(target.chooseSchedule(urlsJson, date));
    if (choice) choices.set(date, choice);
  }
  // Start fetching the schedule tables now. They arrive while the archive files are read.
  for (const choice of choices.values()) {
    if (!target.isCompiled(choice.key)) prefetchSchedule(run, choice);
  }

  // The time zone comes first: service days can't be located in UTC files without it.
  // A schedule's own zone always wins over an estimate saved earlier.
  const savedZone = await run.wait(getEntry<FeedEntry>('feeds', run.feedKey));
  const firstChoice = remaining.map(date => choices.get(date)).find(Boolean);
  let timezone: string | null = null;
  let estimated = false;
  if (firstChoice) {
    timezone = savedZone && !savedZone.estimated ? savedZone.timezone : await run.span('timezone', () => timezoneOf(run, firstChoice));
    if (timezone) await run.wait(putEntry('feeds', run.feedKey, {timezone, estimated: false} satisfies FeedEntry));
  }
  if (!timezone) {
    timezone = savedZone?.timezone ?? (await timezoneFromPositions(run, remaining[0]));
    estimated = true;
    if (timezone) await run.wait(putEntry('feeds', run.feedKey, {timezone, estimated: true} satisfies FeedEntry));
  }
  if (!timezone) throw new Error('This feed has no schedule and no readable positions, so its service days cannot be located.');
  if (estimated) notes.push(`The archive has no schedule stating this agency's time zone, so ${timezone} was estimated from vehicle positions. Hours of the day may be off if that is wrong.`);
  target.setClock(clockSamples(timezone, remaining[0], remaining[remaining.length - 1]));

  const plan: {files: any[]} = JSON.parse(target.planRead(run.feedKey, JSON.stringify(remaining), dateMax));
  target.clearBuffer();
  const totalFiles = plan.files.length;
  // Size every file up front, in parallel. It gives the progress bar a byte total
  // and costs one round trip rather than one per file.
  run.stage('Checking the archive files', 0, 0, remaining.length, {phase: 'lookup'});
  // A failed lookup isn't fatal here: that file is sized again, and fails properly, when its turn comes.
  const sizes: (number | null | undefined)[] = await run.span('sizes', () => run.wait(Promise.all(plan.files.map((file: any) =>
    objectSize(file.url, `Archive ${file.utc_date}`).catch(() => undefined)))));
  const bytesTotal = sizes.reduce<number>((sum, size) => sum + (size ?? 0), 0);
  let bytesBefore = 0;
  let completedDays = 0;
  const missing: [number, number][] = [];
  const failedSchedules = new Map<string, string>();
  const processed = new Set<number>();

  // Download each archive file whole, one ahead of the one being read, so the network
  // works while DuckDB decodes. At most the current file and the next one are held.
  const downloads: (Promise<File> | undefined)[] = [];
  const downloaded: number[] = plan.files.map(() => 0);
  const startDownload = (index: number) => {
    const size = sizes[index];
    if (index >= totalFiles || downloads[index] || !size || size > PREFETCH_MAX_BYTES) return;
    const label = `${plan.files[index].utc_date}`;
    const after = downloads[index - 1]?.catch(() => {}) ?? Promise.resolve();
    const started = after.then(() => run.span(`file ${label} download`, () => downloadObject(run, plan.files[index].url, size, bytes => (downloaded[index] += bytes))));
    started.catch(() => {});
    downloads[index] = started;
  };

  for (const [fileIndex, file] of plan.files.entries()) {
    const started = performance.now();
    const label = `${file.utc_date}`;
    const dayIndex = completedDays + 1;
    const progress = (within: number) => (fileIndex + within) / totalFiles;
    let size = sizes[fileIndex];
    if (size === undefined) size = await run.wait(objectSize(file.url, `Archive ${label}`));
    startDownload(fileIndex);
    startDownload(fileIndex + 1);
    run.stage(`Checking the ${label} archive file`, progress(0), dayIndex, remaining.length, {phase: 'read', bytesDone: bytesBefore, bytesTotal});
    const record: ReadRecord = {date: file.utc_date, url: file.url, bytes: size ?? 0, status: size === null ? 'missing' : 'read', rows: 0, seconds: 0, sql: ''};
    if (size === null) {
      missing.push([file.ends_at - 86400, file.ends_at]);
    } else {
      enforceObjectSize(size, `Archive ${label}`);
      const read = async () => {
        const columns = await run.span(`file ${label} describe`, () => columnsOf(run, file.alias));
        const sql = Engine.fixesQuery(JSON.stringify(columns), file.alias, file.window_start, file.window_end);
        record.sql = sql;
        let lastReport = 0;
        await run.span(`file ${label} query`, () => stream(run, sql, batch => {
          const fetched = numberColumn(batch, 'fetch') as Float64Array;
          const [tripOffsets, tripBytes] = textColumn(batch, 'trip_id');
          const [vehicleOffsets, vehicleBytes] = textColumn(batch, 'vehicle_id');
          const [routeOffsets, routeBytes] = textColumn(batch, 'route_id');
          const [dateOffsets, dateBytes] = textColumn(batch, 'start_date');
          const [timeOffsets, timeBytes] = textColumn(batch, 'start_time');
          target.pushFixes(fetched, numberColumn(batch, 'timestamp'), numberColumn(batch, 'latitude'), numberColumn(batch, 'longitude'),
            numberColumn(batch, 'occupancy_status'), numberColumn(batch, 'differential'),
            tripOffsets, tripBytes, vehicleOffsets, vehicleBytes, routeOffsets, routeBytes, dateOffsets, dateBytes, timeOffsets, timeBytes);
          record.rows += fetched.length;
          const now = performance.now();
          if (now - lastReport > 250 && fetched.length) {
            lastReport = now;
            // Files are written in time order, so the clock shows how far along we are.
            const within = Math.min(1, Math.max(0, (fetched[fetched.length - 1] - file.window_start) / (file.window_end - file.window_start)));
            run.stage(`Reading ${label} from the archive`, progress(within), dayIndex, remaining.length, {phase: 'read', bytesDone: bytesBefore + within * (size ?? 0), bytesTotal});
          }
        }));
      };
      const pending = downloads[fileIndex];
      await run.span(`file ${label}`, async () => {
        if (!pending) return withFile(run, file.alias, file.url, read);
        // Show the download while it is the only thing happening, as the first half of the file.
        const ticker = setInterval(() => {
          const share = downloaded[fileIndex] / (size ?? 1);
          run.stage(`Downloading ${label} from the archive`, progress(share / 2), dayIndex, remaining.length, {phase: 'read', bytesDone: bytesBefore + downloaded[fileIndex], bytesTotal});
        }, 250);
        let local: File;
        try {
          local = await run.wait(pending);
        } finally {
          clearInterval(ticker);
        }
        downloads[fileIndex] = undefined;
        startDownload(fileIndex + 2);
        return withLocalFile(run, file.alias, local, read);
      });
    }
    bytesBefore += size ?? 0;
    record.seconds = (performance.now() - started) / 1000;
    run.emit({event: 'read', record});

    for (const date of file.completes as number[]) {
      processed.add(date);
      const dayNotes = [...notes];
      const choice = choices.get(date);
      if (choice && !failedSchedules.has(choice.key)) {
        try {
          await run.span('schedule', () => loadSchedule(run, choice, formatDate(date)));
        } catch (error) {
          if (error instanceof RunStopped) throw error;
          // A dropped connection says nothing about the schedule. Falling back to GPS speeds
          // here would show, and save, a day that is worse than the one the visitor asked
          // for. Stop with a retryable error instead, and keep what finished before it.
          const classified = classifyError(error, `reading the ${formatDate(date)} schedule`);
          if (isTransient(classified)) throw classified;
          console.warn(`[engine] schedule for ${formatDate(date)} could not be read; falling back to GPS speeds`, error);
          failedSchedules.set(choice.key, error instanceof Error ? error.message : String(error));
        }
      }
      const failure = choice && failedSchedules.get(choice.key);
      if (failure) dayNotes.push(`The schedule for ${formatDate(date)} couldn't be read: ${failure}`);
      const joined = Boolean(choice) && !failure;

      run.stage(`Analyzing ${formatDate(date)}`, progress(1), dayIndex, remaining.length, {phase: 'analyze', date, bytesDone: bytesBefore, bytesTotal});
      const match = joined ? target.tripMatchRate(choice!.key) : 0;
      const hasFixes = target.fixCount() > 0;
      if (joined && hasFixes && match >= MIN_TRIP_MATCH && match < NOTE_TRIP_MATCH) {
        dayNotes.push(`${formatDate(date)}: ${(match * 100).toFixed(0)}% of realtime trip IDs match the schedule, and the rest are left out. This is normal for a feed shared with other agencies, but check the share of scheduled trips observed.`);
      }
      const useSchedule = joined && (!hasFixes || match >= MIN_TRIP_MATCH);
      // Measured whenever positions were compared with a schedule, even if the match was
      // too low to use it. Null when there was nothing to compare.
      const tripMatch = joined && hasFixes ? match : null;
      tripMatches.set(date, tripMatch);
      const missingJson = JSON.stringify(missing);
      const notesJson = JSON.stringify(dayNotes);
      const analysisStarted = performance.now();
      const output = (useSchedule
        ? target.processDay(date, choice!.key, file.ends_at, missingJson, notesJson)
        : target.processGpsDay(date, file.ends_at, missingJson, notesJson)) as {status: string; cube?: Uint8Array; events?: Uint8Array; meta?: Uint8Array; digest?: string};
      run.spans.push({name: `process ${formatDate(date)}`, start: Math.round(analysisStarted - run.origin), end: Math.round(performance.now() - run.origin)});
      completedDays += 1;

      if (output.status === 'no_data') {
        const reason = `The archive has no vehicle data for ${formatDate(date)}.`;
        result.unavailable.push({date, reason});
        run.emit({event: 'unavailable', date, reason});
      } else {
        // Only a whole day is saved. A partial one is read again next time, because
        // the archive may have the rest by then.
        if (output.status === 'complete' && output.cube) {
          const digest = useSchedule ? choice!.key : output.digest!;
          let saved = true;
          if (output.meta) saved = await run.wait(putEntry('schedules', scheduleKey(run.feedKey, digest), {meta: output.meta} satisfies ScheduleEntry));
          saved = saved && (await saveDay(run, date, digest, output.cube, output.events ?? null, tripMatch));
          if (saved) {
            if (output.events) rememberEvents(date);
          }
          // A failed save is reported once by the cache itself, as a notice on the page.
        }
        result.analyzed.push(date);
        run.emit({event: 'day', date, cached: false});
      }

      const next = remaining[remaining.indexOf(date) + 1];
      const nextOrigin = next ? target.serviceOrigin(next) : undefined;
      if (nextOrigin !== undefined) target.evictBefore(nextOrigin);
    }
  }
  target.clearBuffer();

  for (const date of remaining) {
    if (!processed.has(date)) {
      const reason = `${formatDate(date)} is outside the dates this feed has in the archive.`;
      result.unavailable.push({date, reason});
      run.emit({event: 'unavailable', date, reason});
    }
  }
}

async function analyze(request: AnalyzeRequest): Promise<AnalyzeResult> {
  await stopActiveRun();
  const run = new Run(request.run, request.feedKey, openFeedEngine(request.feedKey));
  activeRun = run;
  const result: AnalyzeResult = {analyzed: [], cached: [], unavailable: [], stopped: false, engineVersion};
  try {
    await run.span('total', () => execute(run, request, result));
  } catch (error) {
    if (!(error instanceof RunStopped)) {
      // Say what the run was doing, and keep the original error as the cause.
      console.error(`[engine] run failed while ${run.where}`, error);
      throw classifyError(error, run.where);
    }
    result.stopped = true;
  } finally {
    result.timings = run.spans;
    if (activeRun === run) activeRun = undefined;
    run.finish();
  }
  return result;
}

function formatDate(date: number) {
  return `${Math.floor(date / 10000)}-${String(Math.floor(date / 100) % 100).padStart(2, '0')}-${String(date % 100).padStart(2, '0')}`;
}

// ---- Messages --------------------------------------------------------------

const methods: Record<string, (...args: any[]) => unknown> = {
  async init(url: string) {
    baseUrl = url;
    engineReady ??= init().catch(error => {
      engineReady = undefined;
      throw error;
    });
    await engineReady;
    return true;
  },
  async catalog() {
    // The catalog is several megabytes, so it gets longer than a small request would.
    const data = await archiveJson<Feed[]>('inventory.json', 90_000);
    if (!Array.isArray(data) || data.length > 5000) throw new Error('The archive catalog has an unexpected shape.');
    return data;
  },
  analyze,
  async stop() {
    await stopActiveRun();
    return true;
  },
  async cachedDays(feedKey: string) {
    return listDays(feedKey, Engine.metricVersion());
  },
  async clearCache(feedKey?: string) {
    await stopActiveRun();
    await clearCache(feedKey);
    if (!feedKey || feedKey === currentFeed) {
      engine?.free();
      engine = undefined;
      currentFeed = undefined;
      eventDatesInMemory = [];
      tripMatches = new Map();
    }
    return true;
  },
  async openFeed(feedKey: string) {
    await stopActiveRun();
    openFeedEngine(feedKey);
    return true;
  },
  select(selection: string) {
    engine?.select(selection);
    return true;
  },
  overview: () => withTripMatch(JSON.parse(engine!.overview()), tripMatches),
  routes: () => JSON.parse(engine!.routes()),
  networkMap: (route?: string) => JSON.parse(engine!.networkMap(route)),
  hotspots: () => JSON.parse(engine!.hotspots()),
  routeDetail: (route: string) => JSON.parse(engine!.routeDetail(route)),
  async stringLine(route: string, dir: number, date: number) {
    const target = engine!;
    const feed = currentFeed;
    if (!target.hasEvents(date) && feed) {
      const entry = await getEntry<EventsEntry>('events', dayKey(feed, date, Engine.metricVersion()));
      // The feed may have changed while that was being read.
      if (currentFeed !== feed || engine !== target) throw new Error('The agency changed while this chart was loading.');
      if (entry) {
        target.importEvents(date, entry.events);
        rememberEvents(date);
      }
    }
    return {available: target.hasEvents(date), line: JSON.parse(target.stringLine(route, dir, date))};
  },
  stops: () => JSON.parse(engine!.stops()),
  quality: () => JSON.parse(engine!.quality()),
};

addEventListener('message', async (event: MessageEvent) => {
  const {id, method, args} = event.data;
  try {
    const fn = methods[method];
    if (!fn) throw new Error(`Unknown engine method ${method}`);
    postMessage({id, result: await fn(...args)});
  } catch (error) {
    if (!(error instanceof RunStopped)) console.error(`[engine] ${method} failed`, error);
    postMessage({id, error: serializeError(error, `calling ${method}`)});
  }
});
