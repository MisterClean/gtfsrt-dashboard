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
import {EngineError, classifyError, serializeError} from './errors';
import type {AnalyzeRequest, AnalyzeResult, EngineEvent, Feed, ReadRecord, ScheduleRecord} from './types';

/**
 * Below this share of matching trip IDs the feed and schedule don't belong together,
 * so the day falls back to GPS speeds. It is low on purpose: a feed shared by several
 * agencies matches well under half its trips and still measures its own perfectly.
 */
const MIN_TRIP_MATCH = 0.1;
const NOTE_TRIP_MATCH = 0.8;
const SCHEDULE_TABLES = ['agency', 'routes', 'stops', 'shapes', 'calendar', 'calendar_dates', 'trips', 'stop_times'] as const;
const REQUIRED_TABLES = new Set<string>(['routes', 'stops', 'trips', 'stop_times']);
/** Stop events for this many days stay in memory. The rest are read back on demand. */
const EVENT_DAYS_IN_MEMORY = 3;

let engineReady: Promise<unknown> | undefined;
let engine: Engine | undefined;
let currentFeed: string | undefined;
let baseUrl = '';
let eventDatesInMemory: number[] = [];

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

  cancel() {
    this.cancelled = true;
    this.rejectStopped(new RunStopped());
  }

  wait<T>(promise: Promise<T>): Promise<T> {
    if (this.cancelled) return Promise.reject(new RunStopped());
    return Promise.race([promise, this.stopped]);
  }

  emit(event: EngineEvent) {
    if (!this.cancelled) postMessage({...event, run: this.id});
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

async function archiveJson<T>(path: string, timeout = 30_000): Promise<T> {
  const response = await archiveFetch(`${ARCHIVE}${path}`, {}, timeout);
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

/** Rows from a small table, as plain objects. */
async function rowsOf(run: Run, sql: string) {
  const conn = await run.wait(ensureDatabase());
  return (await run.wait(conn.query(sql))).toArray().map(row => row.toJSON()) as Record<string, any>[];
}

const flag = (value: unknown) => Number(value) === 1;
const text = (value: unknown) => (value === null || value === undefined ? '' : String(value));
const optional = (value: unknown) => (value === null || value === undefined ? undefined : Number(value));

/** Compiles the schedule tables into the engine. */
async function loadSchedule(run: Run, choice: ScheduleChoice, label: string) {
  const {engine: target} = run;
  const key = choice.key;
  if (target.isCompiled(key)) return;
  run.stage(`Reading the ${label} schedule`, undefined, undefined, undefined, {phase: 'schedule'});
  target.beginSchedule(key);
  let timezone: string | null = null;
  for (const base of choice.bases) {
    for (const table of SCHEDULE_TABLES) {
      const url = `${base}/${table}.parquet`;
      const size = await run.wait(objectSize(url, `Schedule table ${table}`));
      if (size === null) {
        if (REQUIRED_TABLES.has(table)) target.addScheduleWarning(`One of this agency's schedule sources has no ${table} table, so its trips are left out.`);
        continue;
      }
      if (size > MAX_SCHEDULE_TABLE_BYTES) throw new Error(`Schedule table ${table} is larger than this app reads.`);
      const alias = `schedule_${table}.parquet`;
      await withFile(run, alias, url, async () => {
        const columns = JSON.stringify(await columnsOf(run, alias));
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
          for (const row of await rowsOf(run, sql)) {
            switch (table) {
              case 'agency': {
                const zone = text(row.agency_timezone);
                if (zone) {
                  target.setTimezone(zone);
                  timezone ??= zone;
                }
                break;
              }
              case 'routes':
                target.addRoute(text(row.route_id), text(row.route_short_name), text(row.route_long_name),
                  optional(row.route_type), text(row.route_color), text(row.route_text_color));
                break;
              case 'stops':
                target.addStop(text(row.stop_id), text(row.stop_code), text(row.stop_name), Number(row.stop_lat), Number(row.stop_lon));
                break;
              case 'calendar':
                target.addCalendar(text(row.service_id), flag(row.monday), flag(row.tuesday), flag(row.wednesday), flag(row.thursday),
                  flag(row.friday), flag(row.saturday), flag(row.sunday), Number(row.start_date), Number(row.end_date));
                break;
              case 'calendar_dates':
                target.addCalendarDate(text(row.service_id), Number(row.date), Number(row.exception_type));
                break;
              case 'trips':
                target.addTrip(text(row.trip_id), text(row.route_id), text(row.service_id), optional(row.direction_id),
                  text(row.shape_id) || undefined, text(row.trip_headsign));
                break;
            }
          }
        }
      });
    }
  }
  run.stage(`Placing stops on the ${label} route lines`, undefined, undefined, undefined, {phase: 'schedule'});
  const meta = target.finishSchedule();
  await run.wait(putEntry('schedules', scheduleKey(run.feedKey, key), {meta} satisfies ScheduleEntry));
  const record: ScheduleRecord = {
    key, bases: choice.bases, retrieved: choice.retrieved, published_before: choice.published_before,
    timezone: timezone ?? target.scheduleTimezone() ?? null, warnings: JSON.parse(target.scheduleWarnings()),
  };
  run.emit({event: 'schedule', record});
}

/** Reads the time zone cheaply when no schedule has been compiled yet. */
async function timezoneOf(run: Run, choice: ScheduleChoice): Promise<string | null> {
  for (const base of choice.bases) {
    const alias = 'schedule_agency_tz.parquet';
    const url = `${base}/agency.parquet`;
    if ((await run.wait(objectSize(url, 'Schedule agency table'))) === null) continue;
    const zone = await withFile(run, alias, url, async () => {
      const columns = JSON.stringify(await columnsOf(run, alias));
      const rows = await rowsOf(run, Engine.scheduleQuery('agency', columns, alias));
      return text(rows[0]?.agency_timezone);
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
    return run.engine.importDay(entry.cube);
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
async function saveDay(run: Run, date: number, digest: string, cube: Uint8Array, events: Uint8Array | null) {
  const version = Engine.metricVersion();
  const key = dayKey(run.feedKey, date, version);
  if (events && !(await run.wait(putEntry('events', key, {events} satisfies EventsEntry)))) return false;
  if (!(await run.wait(putEntry('days', key, {cube, digest, savedAt: new Date().toISOString()} satisfies DayEntry)))) return false;
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
  run.stage('Starting the local database', 0, 0, remaining.length, {phase: 'database'});
  await run.wait(ensureDatabase());
  result.engineVersion = engineVersion;

  run.stage('Looking up this feed in the archive', 0, 0, remaining.length, {phase: 'lookup'});
  const metadata = await withFile(run, 'feeds.parquet', `${ARCHIVE}feeds.parquet`, async () => {
    const statement = await run.wait(connection!.prepare(Engine.feedMetadataQuery()));
    const rows = (await run.wait(statement.query(run.feedKey))).toArray().map(row => row.toJSON());
    await run.wait(statement.close());
    return rows;
  });
  const row = metadata[0] ?? {};
  let scheduleUrls: string[] = [];
  try {
    scheduleUrls = row.schedule_urls ? JSON.parse(String(row.schedule_urls)) : [];
  } catch {
    notes.push("The archive's list of schedules for this feed couldn't be read.");
  }
  if (!scheduleUrls.length && row.schedule_url) scheduleUrls = [String(row.schedule_url)];
  target.setScheduleCatalogs(await run.wait(archiveJson<unknown[]>('schedules.json').then(data => JSON.stringify(data))));
  const urlsJson = JSON.stringify(scheduleUrls);

  // A day with no covering schedule still gets GPS speeds. Only the time zone has
  // to come from somewhere else.
  const choices = new Map<number, ScheduleChoice>();
  for (const date of remaining) {
    const choice: ScheduleChoice | null = JSON.parse(target.chooseSchedule(urlsJson, date));
    if (choice) choices.set(date, choice);
  }

  // The time zone comes first: service days can't be located in UTC files without it.
  // A schedule's own zone always wins over an estimate saved earlier.
  const savedZone = await run.wait(getEntry<FeedEntry>('feeds', run.feedKey));
  const firstChoice = remaining.map(date => choices.get(date)).find(Boolean);
  let timezone: string | null = null;
  let estimated = false;
  if (firstChoice) {
    timezone = savedZone && !savedZone.estimated ? savedZone.timezone : await timezoneOf(run, firstChoice);
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
  const sizes: (number | null | undefined)[] = await run.wait(Promise.all(plan.files.map((file: any) =>
    objectSize(file.url, `Archive ${file.utc_date}`).catch(() => undefined))));
  const bytesTotal = sizes.reduce<number>((sum, size) => sum + (size ?? 0), 0);
  let bytesBefore = 0;
  let completedDays = 0;
  const missing: [number, number][] = [];
  const failedSchedules = new Map<string, string>();
  const processed = new Set<number>();

  for (const [fileIndex, file] of plan.files.entries()) {
    const started = performance.now();
    const label = `${file.utc_date}`;
    const dayIndex = completedDays + 1;
    const progress = (within: number) => (fileIndex + within) / totalFiles;
    let size = sizes[fileIndex];
    if (size === undefined) size = await run.wait(objectSize(file.url, `Archive ${label}`));
    run.stage(`Checking the ${label} archive file`, progress(0), dayIndex, remaining.length, {phase: 'read', bytesDone: bytesBefore, bytesTotal});
    const record: ReadRecord = {date: file.utc_date, url: file.url, bytes: size ?? 0, status: size === null ? 'missing' : 'read', rows: 0, seconds: 0, sql: ''};
    if (size === null) {
      missing.push([file.ends_at - 86400, file.ends_at]);
    } else {
      enforceObjectSize(size, `Archive ${label}`);
      await withFile(run, file.alias, file.url, async () => {
        const columns = await columnsOf(run, file.alias);
        const sql = Engine.fixesQuery(JSON.stringify(columns), file.alias, file.window_start, file.window_end);
        record.sql = sql;
        let lastReport = 0;
        await stream(run, sql, batch => {
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
        });
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
          await loadSchedule(run, choice, formatDate(date));
        } catch (error) {
          if (error instanceof RunStopped) throw error;
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
      const missingJson = JSON.stringify(missing);
      const notesJson = JSON.stringify(dayNotes);
      const output = (useSchedule
        ? target.processDay(date, choice!.key, file.ends_at, missingJson, notesJson)
        : target.processGpsDay(date, file.ends_at, missingJson, notesJson)) as {status: string; cube?: Uint8Array; events?: Uint8Array; meta?: Uint8Array; digest?: string};
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
          saved = saved && (await saveDay(run, date, digest, output.cube, output.events ?? null));
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
    await execute(run, request, result);
  } catch (error) {
    if (!(error instanceof RunStopped)) {
      // Say what the run was doing, and keep the original error as the cause.
      console.error(`[engine] run failed while ${run.where}`, error);
      throw classifyError(error, run.where);
    }
    result.stopped = true;
  } finally {
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
  overview: () => JSON.parse(engine!.overview()),
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
