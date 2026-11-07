// Runs everything heavy off the main thread: DuckDB reads Parquet from the
// public archive, and the Rust engine turns those rows into results. Nothing
// here talks to any server except the archive.
import init, {Engine} from '../../.build/pkg/transit_wasm.js';
import * as duckdb from '@duckdb/duckdb-wasm';
import duckWasm from '@duckdb/duckdb-wasm/dist/duckdb-base.wasm?url';
import duckWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-base.worker.js?url';
import {ARCHIVE, MAX_METADATA_BYTES, MAX_SCHEDULE_TABLE_BYTES, enforceObjectSize, validateArchiveURL} from './contracts.js';
import {CHICAGO_FEEDS, CHICAGO_TIMEZONE, chicagoCatalog, chicagoReportTime, isChicagoFeed, openChicagoArchive} from './sources/chicago';
import {MAX_POSITION_FILE_BYTES, planDailyPositions, sha256, verifiedPositionBytes} from './sources/daily';
import type {DailyObject, PositionFile} from './sources/daily';
import {
  clearCache, dayKey, deleteEntry, getEntry, listDays, putEntry, scheduleKey,
  type DayEntry, type DayIndexEntry, type EventsEntry, type FeedEntry, type ScheduleEntry,
} from './cache';
import type {AnalyzeRequest, AnalyzeResult, EngineEvent, Feed, FeedCatalog, PositionProvenance, ReadRecord, ScheduleRecord} from './types';

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
class RunStopped extends Error {}

/**
 * One analysis. It owns everything it touches, so a stopped run can't write into the
 * run after it or into another agency's results. DuckDB never settles calls in flight
 * when its worker is terminated, so each wait races against `stopped` to unwind at once.
 */
class Run {
  cancelled = false;
  readonly abort = new AbortController();
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

  stage(message: string, fraction = 0, dayIndex = 0, dayCount = 0) {
    this.emit({event: 'stage', message, fraction, dayIndex, dayCount});
  }
}

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
  run.stage(`Reading the ${label} schedule`);
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
  run.stage(`Placing stops on the ${label} route lines`);
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
async function restoreDay(run: Run, date: number, positions?: PositionDay) {
  const version = Engine.metricVersion();
  const key = dayKey(run.feedKey, date, version);
  const entry = await run.wait(getEntry<DayEntry>('days', key));
  if (!entry || entry.positionRevision !== positions?.revision) return false;
  try {
    if (!run.engine.hasSchedule(entry.digest)) {
      const schedule = await run.wait(getEntry<ScheduleEntry>('schedules', scheduleKey(run.feedKey, entry.digest)));
      if (!schedule || !run.engine.importSchedule(schedule.meta)) return false;
    }
    // Stop events load on demand, because most days are never drawn as a string line.
    return run.engine.importDay(entry.cube);
  } catch (error) {
    if (error instanceof RunStopped) throw error;
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
async function saveDay(run: Run, date: number, digest: string, cube: Uint8Array, events: Uint8Array | null, positions?: PositionDay) {
  const version = Engine.metricVersion();
  const key = dayKey(run.feedKey, date, version);
  if (events && !(await run.wait(putEntry('events', key, {events} satisfies EventsEntry)))) return false;
  const entry: DayEntry = {cube, digest, savedAt: new Date().toISOString(), positionRevision: positions?.revision, positions: positions?.provenance};
  if (!(await run.wait(putEntry('days', key, entry)))) return false;
  return run.wait(putEntry('dayIndex', key, {bytes: cube.byteLength} satisfies DayIndexEntry));
}

function rememberEvents(date: number) {
  eventDatesInMemory = [...eventDatesInMemory.filter(d => d !== date), date];
  while (eventDatesInMemory.length > EVENT_DAYS_IN_MEMORY) {
    engine?.dropEvents(eventDatesInMemory.shift()!);
  }
}

interface PositionDay {
  revision: string;
  provenance: PositionProvenance;
  routeType: number | null;
}

interface SourcePlan {
  files: PositionFile[];
  notes?: string[];
  choices?: Map<number, ScheduleChoice>;
}

interface SourceSession {
  ingestion: 'trip' | 'positions';
  days?: Map<number, PositionDay>;
  plan(dates: number[]): Promise<SourcePlan>;
}

interface SourceAdapter {
  name: string;
  matches(key: string): boolean;
  discover(pin?: string): Promise<Feed[]>;
  open(run: Run, request: AnalyzeRequest): Promise<SourceSession>;
}

interface GtfsRtFile {
  url: string;
  utc_date: string;
  window_start: number;
  window_end: number;
  ends_at: number;
  completes: number[];
}

async function planGtfsRt(run: Run, remaining: number[], dateMax: string): Promise<SourcePlan> {
  const target = run.engine;
  const notes: string[] = [];
  run.stage('Starting the local database', 0, 0, remaining.length);
  await run.wait(ensureDatabase());

  run.stage('Looking up this feed in the archive', 0, 0, remaining.length);
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

  const plan: {files: GtfsRtFile[]} = JSON.parse(target.planRead(run.feedKey, JSON.stringify(remaining), dateMax));
  return {
    notes, choices,
    files: plan.files.map(file => ({
      date: file.utc_date, start: file.ends_at - 86400, end: file.ends_at,
      windowStart: file.window_start, windowEnd: file.window_end, completes: file.completes,
      handle: {kind: 'range', url: file.url},
    })),
  };
}

interface DailySource {
  timezone: string;
  manifest?: string;
  reportTime: string;
  routeType: number | null;
  objects: ReadonlyMap<string, DailyObject>;
  gaps: PositionProvenance['gaps'];
}

/** Opens a GPS feed from daily files, whether they were published or picked locally. */
export async function openDailySource(run: Run, dates: number[], source: DailySource): Promise<SourceSession> {
  const {timezone, manifest, reportTime, routeType, objects, gaps} = source;
  run.engine.setClock(clockSamples(timezone, dates[0], dates[dates.length - 1]));
  const windows = new Map(dates.map(date => {
    const [start, end] = run.engine.gpsWindow(date);
    return [date, [start, end] as [number, number]];
  }));
  const all = planDailyPositions(timezone, windows, objects);
  const days = new Map(await Promise.all([...all.days].map(async ([date, day]) => {
    const [start, end] = day.window;
    const overlapping = gaps.filter(gap => gap.start < end && gap.end > start);
    const provenance: PositionProvenance = {date, timezone, manifest, reportTime, ...day, gaps: overlapping};
    // A new index may add or correct unrelated days. Key this result by the
    // inputs that can change it, including the adapter version and gap notes.
    const revision = await sha256(new TextEncoder().encode(JSON.stringify([
      1, timezone, reportTime, routeType, day.window, day.files.map(file => file.sha256 ?? null), overlapping,
    ])));
    return [date, {revision, provenance, routeType}] as const;
  })));
  return {
    ingestion: 'positions', days,
    async plan(selected) {
      if (selected.length === dates.length) return all;
      return planDailyPositions(timezone, new Map(selected.map(date => [date, windows.get(date)!])), objects);
    },
  };
}

const gtfsRt: SourceAdapter = {
  name: 'gtfsrt.io',
  matches: () => true,
  async discover() {
    const feeds = await archiveJson<Feed[]>('inventory.json');
    if (!Array.isArray(feeds) || feeds.length > 5000) throw new Error('The archive catalog has an unexpected shape.');
    return feeds.filter(feed => feed && typeof feed.base64url === 'string' && !isChicagoFeed(feed.base64url))
      .map(({positions: _positions, ...feed}) => feed);
  },
  async open(run, request) {
    return {ingestion: 'trip', plan: dates => planGtfsRt(run, dates, request.dateMax)};
  },
};

const chicago: SourceAdapter = {
  name: 'Chicago Transit Alerts',
  matches: isChicagoFeed,
  async discover(pin) {
    return chicagoCatalog(await openChicagoArchive(pin));
  },
  async open(run, request) {
    const key = request.feedKey;
    if (!isChicagoFeed(key)) throw new Error('Choose a Chicago Transit Alerts feed.');
    run.stage('Opening the Chicago Transit Alerts archive');
    const archive = await openChicagoArchive(request.manifest, run.abort.signal);
    const objects = archive.objects.get(key)!;
    if (!objects.size) throw new Error('This Chicago Transit Alerts manifest has no files for the selected feed.');
    return openDailySource(run, request.dates, {
      timezone: CHICAGO_TIMEZONE, manifest: archive.manifest,
      reportTime: chicagoReportTime(key), routeType: CHICAGO_FEEDS[key] === 'bus' ? 3 : 1,
      objects, gaps: archive.gaps.get(key)!,
    });
  },
};

const sources = [chicago, gtfsRt];

/** Registers a source from another app entry point, such as a local import. */
export function registerPositionSource(adapter: SourceAdapter) {
  sources.unshift(adapter);
}

async function catalog(requested?: string, pin?: string): Promise<FeedCatalog> {
  const results = await Promise.allSettled(sources.map(source => source.discover(
    requested && source.matches(requested) ? pin : undefined,
  )));
  const feeds: Feed[] = [];
  const warnings: string[] = [];
  for (const [index, result] of results.entries()) {
    if (result.status === 'fulfilled') feeds.push(...result.value);
    else warnings.push(`${sources[index].name} could not be loaded. ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
  }
  if (!feeds.length && warnings.length) throw new Error(warnings.join(' '));
  return {feeds, warnings};
}

async function withPositionBuffer(run: Run, alias: string, data: Uint8Array, use: () => Promise<void>) {
  await run.wait(ensureDatabase());
  await run.wait(db!.registerFileBuffer(alias, data));
  try {
    await use();
  } finally {
    if (!run.cancelled) await run.wait(db!.dropFile(alias).catch(() => {}));
  }
}

async function readPositions(run: Run, source: SourceSession, file: PositionFile, progress: (within: number) => void): Promise<ReadRecord> {
  const started = performance.now();
  const handle = file.handle;
  const record: ReadRecord = {
    date: file.date, url: handle?.kind === 'local' ? '' : handle?.url ?? '',
    bytes: 0, status: 'missing', rows: 0, seconds: 0, sql: '',
  };
  const label = `${file.date} positions`;
  const alias = 'positions.parquet';
  let lastReport = 0;
  const use = async () => {
    const columns = JSON.stringify(await columnsOf(run, alias));
    const project = source.ingestion === 'positions' ? Engine.positionFixesQuery : Engine.fixesQuery;
    record.sql = project(columns, alias, file.windowStart, file.windowEnd);
    await stream(run, record.sql, batch => {
      const fetched = numberColumn(batch, 'fetch') as Float64Array;
      const timestamp = numberColumn(batch, 'timestamp');
      const lat = numberColumn(batch, 'latitude');
      const lon = numberColumn(batch, 'longitude');
      const vehicle = textColumn(batch, 'vehicle_id');
      const route = textColumn(batch, 'route_id');
      if (source.ingestion === 'positions') {
        run.engine.pushPositions(fetched, timestamp, lat, lon, numberColumn(batch, 'approximate'), ...vehicle, ...route);
      } else {
        run.engine.pushFixes(fetched, timestamp, lat, lon, numberColumn(batch, 'occupancy_status'), numberColumn(batch, 'differential'),
          ...textColumn(batch, 'trip_id'), ...vehicle, ...route,
          ...textColumn(batch, 'start_date'), ...textColumn(batch, 'start_time'));
      }
      record.rows += fetched.length;
      const now = performance.now();
      if (now - lastReport > 250 && fetched.length) {
        lastReport = now;
        const within = file.rows !== undefined
          ? record.rows / Math.max(1, file.rows)
          : (fetched[fetched.length - 1] - file.windowStart) / (file.windowEnd - file.windowStart);
        progress(Math.min(1, Math.max(0, within)));
      }
    });
    record.status = 'read';
  };

  if (handle?.kind === 'range') {
    const size = await run.wait(objectSize(handle.url, label));
    if (size !== null) {
      record.bytes = enforceObjectSize(size, label);
      await withFile(run, alias, handle.url, use);
    }
  } else if (handle?.kind === 'verified') {
    if (handle.bytes > MAX_POSITION_FILE_BYTES) throw new Error(`${label} exceeds the 64 MiB position file limit.`);
    const response = await run.wait(handle.fetch(run.abort.signal));
    if (response.ok) {
      const data = await run.wait(verifiedPositionBytes(response, handle.bytes, handle.sha256, MAX_POSITION_FILE_BYTES));
      record.bytes = data.byteLength;
      await withPositionBuffer(run, alias, data, use);
    } else if (response.status !== 404) {
      throw new Error(`The archive returned HTTP ${response.status} for ${label}.`);
    }
  } else if (handle?.kind === 'local') {
    if (handle.file.size > MAX_POSITION_FILE_BYTES) throw new Error(`${label} exceeds the 64 MiB position file limit.`);
    const data = new Uint8Array(await run.wait(handle.file.arrayBuffer()));
    if (await run.wait(sha256(data)) !== handle.sha256) throw new Error(`${label} did not match its expected checksum.`);
    record.bytes = data.byteLength;
    await withPositionBuffer(run, alias, data, use);
  }
  record.seconds = (performance.now() - started) / 1000;
  return record;
}

async function execute(run: Run, request: AnalyzeRequest, result: AnalyzeResult) {
  const target = run.engine;
  const dates = [...new Set(request.dates)].sort((a, b) => a - b);
  if (!dates.length || dates.length > 62) throw new Error('Choose between 1 and 62 service days.');
  for (const date of dates) {
    const iso = formatDate(date);
    const instant = Date.parse(iso);
    if (!Number.isInteger(date) || !Number.isFinite(instant) || new Date(instant).toISOString().slice(0, 10) !== iso) {
      throw new Error('Choose valid service dates.');
    }
  }
  const adapter = sources.find(source => source.matches(run.feedKey))!;
  const source = await run.wait(adapter.open(run, {...request, dates}));
  const remaining: number[] = [];
  for (const date of dates) {
    const positions = source.days?.get(date);
    if (positions) target.removeDay(date);
    if (await restoreDay(run, date, positions)) {
      result.cached.push(date);
      if (positions) run.emit({event: 'positions', record: positions.provenance});
      run.emit({event: 'day', date, cached: true});
    } else {
      remaining.push(date);
    }
  }
  if (!remaining.length) return;

  const {files, choices, notes = []} = await run.wait(source.plan(remaining));
  target.clearBuffer();
  const totalFiles = files.length;
  let completedDays = 0;
  let saveFailed = false;
  const missing: [number, number][] = [];
  const failedSchedules = new Map<string, string>();
  const processed = new Set<number>();

  const missingFiles = new Set<string>();

  for (const [fileIndex, file] of files.entries()) {
    const label = file.date;
    const dayIndex = completedDays + 1;
    const progress = (within: number) => (fileIndex + within) / totalFiles;
    run.stage(`Checking the ${label} archive file`, progress(0), dayIndex, remaining.length);
    const record = await readPositions(run, source, file, within => {
      run.stage(`Reading ${label} from the archive`, progress(within), dayIndex, remaining.length);
    });
    result.engineVersion = engineVersion;
    if (record.status === 'missing') {
      missing.push([file.start, file.end]);
      missingFiles.add(file.date);
    }
    run.emit({event: 'read', record});

    for (const date of file.completes) {
      processed.add(date);
      const dayNotes = [...notes];
      const positions = source.days?.get(date);
      const choice = choices?.get(date);
      if (positions) {
        dayNotes.push(positions.provenance.reportTime);
        for (const gap of positions.provenance.gaps) {
          const time = new Intl.DateTimeFormat('en-US', {
            timeZone: positions.provenance.timezone, month: 'short', day: 'numeric', hour: 'numeric', minute: 'numeric', timeZoneName: 'short',
          });
          dayNotes.push(`${gap.reduced ? 'Reduced polling' : 'Known archive gap'} (${time.formatRange(gap.start * 1000, gap.end * 1000)}). ${gap.note}`);
        }
      }
      if (choice && !failedSchedules.has(choice.key)) {
        try {
          await loadSchedule(run, choice, formatDate(date));
        } catch (error) {
          if (error instanceof RunStopped) throw error;
          failedSchedules.set(choice.key, error instanceof Error ? error.message : String(error));
        }
      }
      const failure = choice && failedSchedules.get(choice.key);
      if (failure) dayNotes.push(`The schedule for ${formatDate(date)} couldn't be read: ${failure}`);
      const joined = Boolean(choice) && !failure;

      run.stage(`Analyzing ${formatDate(date)}`, progress(1), dayIndex, remaining.length);
      const match = joined ? target.tripMatchRate(choice!.key) : 0;
      const hasFixes = target.fixCount() > 0;
      if (joined && hasFixes && match >= MIN_TRIP_MATCH && match < NOTE_TRIP_MATCH) {
        dayNotes.push(`${formatDate(date)}: ${(match * 100).toFixed(0)}% of realtime trip IDs match the schedule, and the rest are left out. This is normal for a feed shared with other agencies, but check the share of scheduled trips observed.`);
      }
      const useSchedule = joined && (!hasFixes || match >= MIN_TRIP_MATCH);
      const missingJson = JSON.stringify(missing);
      const notesJson = JSON.stringify(dayNotes);
      const options = positions ? JSON.stringify({
        revision: positions.revision, route_type: positions.routeType,
        outages: positions.provenance.gaps.filter(gap => !gap.reduced).map(gap => [Math.floor(gap.start), Math.ceil(gap.end)]),
        reduced_polling: positions.provenance.gaps.some(gap => gap.reduced),
      }) : undefined;
      const output = (useSchedule
        ? target.processDay(date, choice!.key, file.end, missingJson, notesJson)
        : target.processGpsDay(date, file.end, missingJson, notesJson, options)) as {status: string; cube?: Uint8Array; events?: Uint8Array; meta?: Uint8Array; digest?: string};
      completedDays += 1;

      if (positions) {
        positions.provenance.files = positions.provenance.files.map(file => ({...file, missing: missingFiles.has(file.date)}));
        run.emit({event: 'positions', record: positions.provenance});
      }
      if (output.status === 'no_data') {
        const reason = positions
          ? `No usable positions were available for ${formatDate(date)}. Check the files and coverage in Data & methods.`
          : `The archive has no vehicle data for ${formatDate(date)}.`;
        result.unavailable.push({date, reason});
        run.emit({event: 'unavailable', date, reason});
      } else {
        // Only a whole day is saved. A partial one is read again next time, because
        // the archive may have the rest by then.
        if (output.status === 'complete' && output.cube) {
          const digest = useSchedule ? choice!.key : output.digest!;
          let saved = true;
          if (output.meta) saved = await run.wait(putEntry('schedules', scheduleKey(run.feedKey, digest), {meta: output.meta} satisfies ScheduleEntry));
          saved = saved && (await saveDay(run, date, digest, output.cube, output.events ?? null, positions));
          if (saved) {
            if (output.events) rememberEvents(date);
          } else if (!saveFailed) {
            saveFailed = true;
            run.emit({event: 'warning', message: "Your browser couldn't save these results, perhaps because its storage is full. They are here for this visit, but will need analyzing again next time."});
          }
        }
        result.analyzed.push(date);
        run.emit({event: 'day', date, cached: false});
      }

      const next = remaining[remaining.indexOf(date) + 1];
      const nextOrigin = next ? (positions ? target.gpsWindow(next)[0] : target.serviceOrigin(next)) : undefined;
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
    if (!run.cancelled && !(error instanceof RunStopped)) throw error;
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
  catalog,
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
    postMessage({id, error: error instanceof Error ? error.message : String(error)});
  }
});
