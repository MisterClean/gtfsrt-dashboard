// Rebuilds the local CTA input cache for the Nov. 10, 2026 Routes snapshot.
// Run with Node 24+, curl, unzip and DuckDB. All source data stays under .cache/cta.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {copyFile, mkdir, readFile, rename, rm, stat, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {promisify} from 'node:util';

const run = promisify(execFile);
const root = resolve(import.meta.dirname, '..', '.cache', 'cta');
const archiveOrigin = 'https://data.chicagotransitalerts.app/';
const manifestHash = '1300d4d5dba9025f7c9da62a9b57f7e5b5efac3ddf45a63ef27586c43ee5b925';
const manifestPath = `positions/manifests/${manifestHash}.json`;
const scheduleUrl = 'https://files.mobilitydatabase.org/mdb-389/mdb-389-202609160157/mdb-389-202609160157.zip';
const scheduleHash = 'a9372be5b70fcee4ed98c9476433f86065637a9a500b8af6afbb84d000ef2746';
const asOfDate = '2026-11-10';
const timezone = 'America/Chicago';
const dayMs = 86_400_000;
const hourMs = 3_600_000;
const offsetFormat = new Intl.DateTimeFormat('en-US', {timeZone: timezone, timeZoneName: 'longOffset'});
const sqlString = (value) => `'${value.replaceAll("'", "''")}'`;

function isoDate(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function weekdaysBefore(date, count) {
  const days = [];
  for (let cursor = Date.parse(date) - dayMs; days.length < count; cursor -= dayMs) {
    const weekday = new Date(cursor).getUTCDay();
    if (weekday >= 1 && weekday <= 5) days.push(isoDate(cursor));
  }
  return days.reverse();
}

function offsetSeconds(timestamp) {
  const name = offsetFormat.formatToParts(timestamp).find((part) => part.type === 'timeZoneName')?.value;
  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(name);
  assert(match, `Could not determine ${timezone} UTC offset`);
  const [, sign, hours, minutes] = match;
  return (Number(hours) * 3600 + Number(minutes) * 60) * (sign === '-' ? -1 : 1);
}

export function localMidnight(date) {
  const utc = Date.parse(date);
  const guess = utc - 1000 * offsetSeconds(utc);
  const utcOffsetSeconds = offsetSeconds(guess);
  return {midnightMs: utc - 1000 * utcOffsetSeconds, utcOffsetSeconds};
}

export function gapsOnDate(gaps, date) {
  const {midnightMs} = localMidnight(date);
  const tomorrow = localMidnight(isoDate(Date.parse(date) + dayMs)).midnightMs;
  return gaps
    .filter((gap) => gap.feeds.includes('bus') && Date.parse(gap.start) < tomorrow && Date.parse(gap.end) > midnightMs)
    .map(({start, end, note}) => ({start, end, note}));
}

function clockSamples(first, last) {
  const samples = [];
  const start = Date.parse(first) - dayMs;
  const end = Date.parse(last) + 2 * dayMs;
  for (let at = start; at <= end; at += hourMs) {
    const offset = offsetSeconds(at);
    if (samples.at(-1)?.[1] !== offset) samples.push([at / 1000, offset]);
  }
  return samples;
}

async function verify(path, sha256, bytes) {
  const info = await stat(path).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info?.isFile() || (bytes !== undefined && info.size !== bytes)) return false;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex') === sha256;
}

async function download(url, path, sha256, bytes) {
  if (await verify(path, sha256, bytes)) return;
  const temporary = `${path}.part`;
  try {
    await run('curl', [
      '--fail', '--silent', '--show-error', '--location', '--connect-timeout', '15',
      '--max-time', '180', '--retry', '5', '--retry-all-errors', '--output', temporary, url,
    ]);
    assert(await verify(temporary, sha256, bytes), `Checksum or size mismatch for ${url}`);
    await rename(temporary, path);
  } finally {
    await rm(temporary, {force: true});
  }
}

const duckDbEnvironment = {...process.env};
delete duckDbEnvironment.CODEX_CI;

async function duckdb(sql, json = false) {
  const format = json ? ['-json'] : [];
  const {stdout} = await run('duckdb', ['-batch', ...format, '-c', sql], {env: duckDbEnvironment});
  return stdout;
}

async function prepareSchedule(requestedDates) {
  const zip = join(root, 'static-20260916.zip');
  const raw = join(root, 'schedule-raw');
  const output = join(root, 'schedule');
  await download(scheduleUrl, zip, scheduleHash, 68_738_293);
  await Promise.all([mkdir(raw, {recursive: true}), mkdir(output, {recursive: true})]);
  await run('unzip', ['-oq', zip, '*.txt', '-d', raw]);
  const read = (name) => `read_csv(${sqlString(join(raw, `${name}.txt`))}, all_varchar = true)`;
  const out = (name) => sqlString(join(output, `${name}.csv.part`));
  const dateValues = requestedDates.map((date) => `(DATE ${sqlString(date)})`).join(', ');
  await duckdb(`
    CREATE TEMP TABLE dates AS SELECT service_date, strftime(service_date, '%Y%m%d') AS gtfs_date
      FROM (VALUES ${dateValues}) days(service_date);
    CREATE TEMP TABLE exceptions AS SELECT * FROM ${read('calendar_dates')};
    CREATE TEMP TABLE active_services AS
      SELECT DISTINCT service_id FROM (
        SELECT c.service_id
        FROM dates d JOIN ${read('calendar')} c
          ON d.gtfs_date BETWEEN c.start_date AND c.end_date
          AND [monday, tuesday, wednesday, thursday, friday, saturday, sunday][isodow(d.service_date)] = '1'
        ANTI JOIN exceptions e ON e.service_id = c.service_id AND e.date = d.gtfs_date AND e.exception_type = '2'
        UNION
        SELECT e.service_id
        FROM dates d JOIN exceptions e ON e.date = d.gtfs_date AND e.exception_type = '1'
      );
    CREATE TEMP TABLE routes AS SELECT * FROM ${read('routes')} WHERE route_type = '3';
    CREATE TEMP TABLE trips AS SELECT t.* FROM ${read('trips')} t
      SEMI JOIN routes USING (route_id) SEMI JOIN active_services USING (service_id);
    CREATE TEMP TABLE stop_times AS SELECT s.* FROM ${read('stop_times')} s SEMI JOIN trips USING (trip_id);
    COPY routes TO ${out('routes')} (FORMAT CSV, HEADER);
    COPY trips TO ${out('trips')} (FORMAT CSV, HEADER);
    COPY (SELECT s.* FROM ${read('shapes')} s SEMI JOIN trips USING (shape_id))
      TO ${out('shapes')} (FORMAT CSV, HEADER);
    COPY stop_times TO ${out('stop_times')} (FORMAT CSV, HEADER);
    COPY (SELECT s.* FROM ${read('stops')} s SEMI JOIN stop_times USING (stop_id))
      TO ${out('stops')} (FORMAT CSV, HEADER);
  `);
  await Promise.all(['routes', 'trips', 'shapes', 'stop_times', 'stops'].map((name) =>
    rename(join(output, `${name}.csv.part`), join(output, `${name}.csv`))));
  await Promise.all(['agency', 'calendar', 'calendar_dates'].map(async (name) => {
    const finalPath = join(output, `${name}.csv`);
    await copyFile(join(raw, `${name}.txt`), `${finalPath}.part`);
    await rename(`${finalPath}.part`, finalPath);
  }));
}

async function prepareBusDay(date, entry, knownGaps) {
  const {path, sha256, bytes, rows} = entry;
  assert.match(path, /^positions\/bus\/\d{4}\/\d{2}\/\d{4}-\d{2}-\d{2}\.[a-f0-9]{64}\.parquet$/);
  const input = join(root, 'parquet', `${date}.parquet`);
  const output = join(root, 'positions', `${date}.csv`);
  const parquet = `read_parquet(${sqlString(input)})`;
  await download(new URL(path, archiveOrigin).href, input, sha256, bytes);
  const [audit] = JSON.parse(await duckdb(`
    WITH polls AS (
      SELECT ts, count(*) AS rows,
        count_if(vehicle_ts IS NOT NULL) AS vehicle_timestamps,
        count_if(sched_start_sec IS NOT NULL AND sched_start_date IS NOT NULL) AS trip_starts
      FROM ${parquet} GROUP BY ts
    ), intervals AS (
      SELECT *, (ts - lag(ts) OVER (ORDER BY ts)) / 1000 AS gap_seconds FROM polls
    )
    SELECT sum(rows)::BIGINT AS rows, count(*) AS distinctPolls, min(ts) AS firstPollMs,
      max(ts) AS lastPollMs, max(gap_seconds) AS largestPollGapSeconds,
      median(gap_seconds) AS medianPollIntervalSeconds,
      sum(vehicle_timestamps)::BIGINT AS vehicleTimestampRows, sum(trip_starts)::BIGINT AS scheduledStartRows
    FROM intervals;
  `, true));
  assert.equal(audit.rows, rows, `Bus archive row count for ${date}`);
  assert.equal(audit.distinctPolls, entry.quality.distinct_polls, `Bus archive poll count for ${date}`);
  assert.equal(audit.firstPollMs, entry.ts_min, `Bus archive first poll for ${date}`);
  assert.equal(audit.lastPollMs, entry.ts_max, `Bus archive last poll for ${date}`);
  const midnight = localMidnight(date);
  const tomorrow = localMidnight(isoDate(Date.parse(date) + dayMs)).midnightMs;
  assert(audit.firstPollMs >= midnight.midnightMs && audit.lastPollMs < tomorrow, `Polls outside local day ${date}`);
  await duckdb(`
    COPY (
      SELECT ts, vehicle_ts, route, pid, vehicle_id, destination, lat, lon, pdist, heading,
        sched_start_sec, sched_start_date FROM ${parquet}
    ) TO ${sqlString(`${output}.part`)} (FORMAT CSV, HEADER);
  `);
  await rename(`${output}.part`, output);
  const gaps = gapsOnDate(knownGaps, date);
  return [date, {...audit, ...midnight, bytes, sha256, notes: gaps.map((gap) => gap.note), gaps}];
}

async function main() {
  await Promise.all(['parquet', 'positions'].map((name) => mkdir(join(root, name), {recursive: true})));
  const manifestFile = join(root, 'positions-manifest.json');
  await download(new URL(manifestPath, archiveOrigin).href, manifestFile, manifestHash, 151054);
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  assert.equal(manifest.schema_version, 2);
  assert.equal(manifest.timezone, timezone);
  const requestedDates = weekdaysBefore(asOfDate, 20);
  const first = requestedDates[0];
  const last = requestedDates.at(-1);
  const calendar = new Map(manifest.days.filter((day) => day.files.bus).map((day) => [day.date, day.files.bus]));
  for (const day of requestedDates) assert(calendar.has(day), `No bus archive for requested weekday ${day}`);
  const latestPublishedDate = [...calendar.keys()].sort().at(-1);
  const days = [...calendar.keys()].sort().filter((day) => day >= first && day <= last);
  const entries = [];
  await prepareSchedule(requestedDates);
  for (const date of days) {
    entries.push(await prepareBusDay(date, calendar.get(date), manifest.known_gaps));
    console.log(`Verified ${date} (${calendar.get(date).rows.toLocaleString('en-US')} bus reports)`);
  }
  const coverage = {
    requestedDates, timezone, latestPublishedDate, manifestGeneratedAt: manifest.generated_at,
    clockSamples: clockSamples(first, last),
    sources: [
      {label: 'Chicago Transit Alerts · Positions archive', url: new URL('positions/index.json', archiveOrigin).href},
      {label: 'Chicago Transit Alerts · pinned archive manifest', url: new URL(manifestPath, archiveOrigin).href},
      {label: 'Mobility Database · CTA schedules', url: 'https://mobilitydatabase.org/feeds/gtfs/mdb-389'},
    ],
    schedule: {url: scheduleUrl, sha256: scheduleHash},
    dates: Object.fromEntries(entries),
  };
  const file = join(root, 'coverage.json');
  await writeFile(`${file}.part`, `${JSON.stringify(coverage, null, 2)}\n`);
  await rename(`${file}.part`, file);
  console.log(`Wrote ${file}`);
}

if (import.meta.main) await main();
