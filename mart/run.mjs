#!/usr/bin/env node
// Transit operations data mart runner.
//
//   node mart/run.mjs fetch --systems metro-transit-madison --dates 2026-11-04
//   node mart/run.mjs build --systems metro-transit-madison --dates 2026-11-04
//   node mart/run.mjs test
//   node mart/run.mjs all   --systems ... --dates ...      (fetch, build, test)
//
// Options
//   --systems a,b      system keys: agency_id, or agency_id-system_id (see cat_feed)
//   --dates d1,d2      GTFS service dates, YYYY-MM-DD
//   --hours 14-17      thin slice: only read captures inside these local service hours
//   --from 20          start the build at the first SQL file numbered >= 20
//   --only 41          run only SQL files whose number starts with this prefix
//   --db path          DuckDB file (default mart/data/mart.duckdb)
//   --data path        data directory (default mart/data)
//
// The SQL in mart/sql is the deliverable. This script only passes parameters,
// downloads the archive objects the plan asks for, and runs the files in order.

import { spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARCHIVE_URL = 'https://storage.googleapis.com/parquet.gtfsrt.io';

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i += 1) {
    if (!rest[i].startsWith('--')) throw new Error(`Unexpected argument ${rest[i]}`);
    opts[rest[i].slice(2)] = rest[i + 1];
    i += 1;
  }
  return { command, opts };
}

const { command, opts } = parseArgs(process.argv.slice(2));
const dataDir = resolve(opts.data ?? join(HERE, 'data'));
const archiveDir = join(dataDir, 'archive');
const dbPath = resolve(opts.db ?? join(dataDir, 'mart.duckdb'));
const sqlDir = join(HERE, 'sql');
const testDir = join(HERE, 'tests');

const sqlString = (s) => `'${String(s).replaceAll("'", "''")}'`;
const sqlList = (xs) => `[${xs.map(sqlString).join(', ')}]`;

function paramsSql() {
  if (!opts.systems || !opts.dates) throw new Error('--systems and --dates are required');
  const systems = opts.systems.split(',').map((s) => s.trim()).filter(Boolean);
  const dates = opts.dates.split(',').map((s) => s.trim()).filter(Boolean);
  for (const d of dates) if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`Bad date ${d}`);
  let [h0, h1] = [0, 30];
  if (opts.hours) {
    [h0, h1] = opts.hours.split('-').map(Number);
    if (!(h0 >= 0 && h1 > h0 && h1 <= 30)) throw new Error('--hours must look like 14-17, within 0-30');
  }
  return [
    `SET VARIABLE archive_dir = ${sqlString(archiveDir)};`,
    `SET VARIABLE systems = ${sqlList(systems)};`,
    `SET VARIABLE service_dates = ${sqlList(dates)}::DATE[];`,
    `SET VARIABLE slice_start_hour = ${h0};`,
    `SET VARIABLE slice_end_hour = ${h1};`,
  ].join('\n');
}

function duckdb(script, { capture = false } = {}) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const result = spawnSync('duckdb', ['-no-agent', '-bail', ...(capture ? ['-json'] : []), dbPath], {
    input: script,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    stdio: ['pipe', capture ? 'pipe' : 'inherit', 'inherit'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`duckdb exited with status ${result.status}`);
  return result.stdout;
}

function sqlFiles(dir) {
  return readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
}

async function download(url, path, { optional = false } = {}) {
  if (existsSync(path) && statSync(path).size > 0) return 'cached';
  mkdirSync(dirname(path), { recursive: true });
  const response = await fetch(url);
  if (response.status === 404 && optional) return 'absent';
  if (!response.ok) throw new Error(`${response.status} for ${url}`);
  const tmp = `${path}.part`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(tmp));
  renameSync(tmp, path);
  return 'downloaded';
}

async function fetchCatalogs() {
  for (const name of ['inventory.json', 'feeds.parquet', 'schedules.json']) {
    const path = join(archiveDir, name);
    // Catalogs change daily; refresh when older than a day.
    if (existsSync(path) && Date.now() - statSync(path).mtimeMs > 86_400_000) rmSync(path);
    await download(`${ARCHIVE_URL}/${name}`, path);
  }
}

async function fetchObjects() {
  await fetchCatalogs();
  const planSql = sqlFiles(sqlDir).filter((f) => f < '10').map((f) => `.read ${join(sqlDir, f)}`).join('\n');
  duckdb(`${paramsSql()}\n${planSql}\n`);
  const out = duckdb('SELECT object_path, is_optional FROM plan_object ORDER BY object_path;', { capture: true });
  const objects = JSON.parse(out || '[]');
  let cursor = 0;
  const counts = { cached: 0, downloaded: 0, absent: 0 };
  async function worker() {
    while (cursor < objects.length) {
      const o = objects[cursor];
      cursor += 1;
      const url = `${ARCHIVE_URL}/${o.object_path.split('/').map(encodeURIComponent).join('/').replaceAll('%3D', '=')}`;
      const state = await download(url, join(archiveDir, o.object_path), { optional: o.is_optional });
      counts[state] += 1;
      if (state === 'downloaded') console.log(`  fetched ${o.object_path}`);
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));
  console.log(`fetch: ${counts.downloaded} downloaded, ${counts.cached} cached, ${counts.absent} absent (optional)`);
}

function build() {
  const files = sqlFiles(sqlDir).filter((f) => {
    if (opts.only) return f.startsWith(opts.only) || f < '10';
    if (opts.from) return f >= opts.from || f < '10';
    return true;
  });
  const lines = [paramsSql(), '.timer on'];
  for (const f of files) lines.push(`.print '-- ${f}'`, `.read ${join(sqlDir, f)}`);
  duckdb(`${lines.join('\n')}\n`);
}

// A test is a SQL file whose final statement returns one row per violation.
function test() {
  let failed = 0;
  for (const f of sqlFiles(testDir)) {
    const sql = readFileSync(join(testDir, f), 'utf8');
    const rows = JSON.parse(duckdb(sql, { capture: true }) || '[]');
    if (rows.length === 0) {
      console.log(`ok    ${f}`);
    } else {
      failed += 1;
      console.log(`FAIL  ${f}  (${rows.length} row${rows.length === 1 ? '' : 's'})`);
      for (const row of rows.slice(0, 5)) console.log(`      ${JSON.stringify(row)}`);
    }
  }
  if (failed) {
    console.error(`${failed} test file(s) failed`);
    process.exit(1);
  }
}

try {
  if (command === 'fetch') await fetchObjects();
  else if (command === 'build') build();
  else if (command === 'test') test();
  else if (command === 'all') {
    await fetchObjects();
    build();
    test();
  } else {
    console.error('Usage: node mart/run.mjs <fetch|build|test|all> --systems a,b --dates YYYY-MM-DD[,..] [--hours 14-17]');
    process.exit(2);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
