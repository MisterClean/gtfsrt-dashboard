import * as duckdb from '@duckdb/duckdb-wasm';

const base = 'https://storage.googleapis.com/parquet.gtfsrt.io';
const output = document.querySelector('#output');
const result = {
  startedAt: new Date().toISOString(),
  userAgent: navigator.userAgent,
  origin: location.origin,
  crossOriginIsolated,
  checks: [],
};
window.probeResult = result;
const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
const rows = table => table.toArray().map(row => row.toJSON());
const literal = value => `'${value.replaceAll("'", "''")}'`;
let db;
let conn;
let vehiclePath = 'madison.parquet';

async function check(name, fn) {
  window.probePhase = name;
  console.log(`PROBE_START ${name}`);
  const start = performance.now();
  try {
    const value = await fn();
    result.checks.push({name, ok: true, milliseconds: Math.round(performance.now() - start), value});
    output.textContent = json(result);
    console.log(`PROBE ${name}: PASS`);
    return value;
  } catch (error) {
    result.checks.push({name, ok: false, milliseconds: Math.round(performance.now() - start), error: String(error)});
    output.textContent = json(result);
    throw error;
  }
}

async function query(sql) {
  sql = sql.replaceAll("'madison.parquet'", literal(vehiclePath));
  return {sql, rows: rows(await conn.query(sql))};
}

try {
  const inventory = await check('browser-fetch-inventory', async () => {
    const response = await fetch(`${base}/inventory.json`, {credentials: 'omit'});
    if (!response.ok) throw new Error(`Inventory HTTP ${response.status}`);
    const data = await response.json();
    result.inventory = {feeds: data.length, agencies: new Set(data.map(f => f.agency_id)).size};
    return data;
  });
  // Keep results small; retain the chosen feed and inventory summary, not all catalog records.
  result.checks[0].value = result.inventory;
  const feed = inventory.find(f => f.agency_id === 'metro-transit-madison' && f.feed_type === 'vehicle_positions');
  if (!feed) throw new Error('Madison vehicle-position feed is absent');
  const date = new URL(location.href).searchParams.get('date') || '2026-11-05';
  result.selection = {date, feed};
  const objectURL = `${base}/${feed.feed_type}/date=${date}/base64url=${feed.base64url}/data.parquet`;
  await check('browser-head', async () => {
    const r = await fetch(objectURL, {method: 'HEAD', credentials: 'omit'});
    if (!r.ok) throw new Error(`HEAD HTTP ${r.status}`);
    return {status: r.status, contentLength: r.headers.get('content-length'), visibleHeaders: Object.fromEntries(r.headers)};
  });
  await check('browser-range', async () => {
    const r = await fetch(objectURL, {headers: {Range: 'bytes=0-3'}, credentials: 'omit'});
    const magic = await r.text();
    if (r.status !== 206 || magic !== 'PAR1') throw new Error(`Range failed: ${r.status} ${magic.slice(0,20)}`);
    return {status: r.status, magic, visibleContentRange: r.headers.get('content-range')};
  });
  await check('instantiate-wasm', async () => {
    const dist = '/node_modules/@duckdb/duckdb-wasm/dist';
    const worker = new Worker(`${dist}/duckdb-browser-base.worker.js`);
    worker.addEventListener('error', error => console.error('WORKER_ERROR', error.message, error.filename, error.lineno));
    db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
    await db.instantiate(`${dist}/duckdb-base.wasm`);
    await db.open({maximumThreads: 1, filesystem: {
      allowFullHTTPReads: false, forceFullHTTPReads: false, reliableHeadRequests: true,
    }});
    conn = await db.connect();
    await conn.query("SET memory_limit = '512MB'");
    return {bundle: 'base', maximumThreads: 1, allowFullHTTPReads: false, forceFullHTTPReads: false};
  });
  await check('engine-version', async () => {
    const value = await query('SELECT version() AS engine_version');
    if (value.rows[0].engine_version !== 'v2.0.0') throw new Error(`Expected v2.0.0: ${json(value.rows)}`);
    return value;
  });
  await check('register-remote-parquet', async () => {
    await db.registerFileURL('madison.parquet', objectURL, duckdb.DuckDBDataProtocol.HTTP, false);
    return {url: objectURL, directIO: false};
  });
  await check('vehicle-schema', () => query("DESCRIBE SELECT * FROM read_parquet('madison.parquet')"));
  await check('vehicle-row-count', () => query("SELECT count(*) AS rows FROM read_parquet('madison.parquet')"));
  if (new URL(location.href).searchParams.get('sample') === 'all') {
    await check('vehicle-sample', () => query("SELECT * FROM read_parquet('madison.parquet') LIMIT 2"));
  }
  await check('vehicle-route-aggregate', () => query(`
    SELECT route_id, count(*) AS snapshot_rows,
           count(DISTINCT vehicle_id) AS distinct_reported_vehicles,
           min(fetch_timestamp) AS first_fetch, max(fetch_timestamp) AS last_fetch
    FROM read_parquet('madison.parquet')
    GROUP BY route_id ORDER BY snapshot_rows DESC LIMIT 10
  `));
  await check('feed-metadata', async () => {
    await db.registerFileURL('feeds.parquet', `${base}/feeds.parquet`, duckdb.DuckDBDataProtocol.HTTP, false);
    return query("SELECT * FROM read_parquet('feeds.parquet') WHERE agency_id = 'metro-transit-madison'");
  });
  await check('schedule-catalog', async () => {
    const r = await fetch(`${base}/schedules.json`, {credentials: 'omit'});
    if (!r.ok) throw new Error(`Schedules HTTP ${r.status}`);
    const data = await r.json();
    return {schedules: data.length, madison: data.filter(x => /madison/i.test(x.schedule_url))};
  });
  result.ok = true;
} catch (error) {
  result.ok = false;
  result.error = String(error);
} finally {
  result.finishedAt = new Date().toISOString();
  output.textContent = json(result);
  window.probeDone = true;
  // Closing the browser/tab owns worker cleanup, including queries blocked in network I/O.
}
