import * as duckdb from '@duckdb/duckdb-wasm';
import {ARCHIVE, MAX_METADATA_BYTES, validateArchiveURL, validateManifest, enforceObjectBudget} from 'gtfsrt-contracts';
let worker;
let db;
let connection;
let operation;

// Executable assets are copied into the same release by scripts/build.mjs.
const engineAsset = name => new URL(`${__DUCKDB_BASE_PATH__}${name}`, import.meta.url).href;
const plainRows = table => JSON.parse(JSON.stringify(table.toArray().map(row => row.toJSON()), (_, value) => {
  if (typeof value !== 'bigint') return value;
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error('A result exceeds JavaScript’s safe integer range.');
  return number;
}));

export function cancelArchive() {
  operation?.controller.abort(new Error('Canceled. The local database was cleared. Load an archive to start again.'));
  operation = undefined;
  worker?.terminate();
  worker = db = connection = undefined;
}

function begin() {
  operation?.controller.abort(new Error('Replaced by a new selection.'));
  const current = {controller: new AbortController(), progress: () => {}};
  operation = current;
  return current;
}

async function guard(promise, current) {
  const {signal} = current.controller;
  signal.throwIfAborted();
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, {once: true});
  });
  try { return await Promise.race([promise, aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

async function fetchArchive(url, current, options = {}) {
  validateArchiveURL(url);
  const signal = AbortSignal.any([current.controller.signal, AbortSignal.timeout(15_000)]);
  return fetch(url, {...options, signal, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-cache'});
}

async function query(sql, current) {
  const soft = setTimeout(() => {
    current.progress('This query is taking longer than 15 seconds. Requesting cancellation…');
    connection?.cancelSent().catch(() => {});
  }, 15_000);
  const hard = setTimeout(() => {
    current.controller.abort(new Error('The query exceeded 30 seconds. The worker was reset. Try one day or a smaller feed.'));
    worker?.terminate();
    worker = db = connection = undefined;
  }, 30_000);
  try { return plainRows(await guard(connection.query(sql), current)); }
  finally { clearTimeout(soft); clearTimeout(hard); }
}

async function initialize(current) {
  if (connection) return;
  if (!globalThis.WebAssembly || !globalThis.Worker) throw new Error('This browser needs WebAssembly and Web Workers. Try a current desktop Chrome or Edge browser.');
  current.progress('Starting the local DuckDB engine…');
  worker = new Worker(engineAsset('duckdb-browser-base.worker.js'), {name: 'gtfsrt-duckdb'});
  db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  const startup = setTimeout(() => cancelArchive(), 30_000);
  try {
    await guard(db.instantiate(engineAsset('duckdb-base.wasm')), current);
    await guard(db.open({maximumThreads: 1, filesystem: {
      allowFullHTTPReads: false, forceFullHTTPReads: false, reliableHeadRequests: true,
    }}), current);
    connection = await guard(db.connect(), current);
    await query("SET memory_limit = '512MB'; SET autoinstall_known_extensions = false; SET autoload_known_extensions = false; SET allow_unsigned_extensions = false; SET allow_community_extensions = false;", current);
    const repository = engineAsset('extensions/');
    await query(`SET custom_extension_repository = '${repository.replaceAll("'", "''")}'; INSTALL parquet; LOAD parquet; INSTALL icu; LOAD icu; SET TimeZone = 'UTC';`, current);
    const [{engine_version}] = await query('SELECT version() AS engine_version', current);
    if (engine_version !== 'v2.0.0') throw new Error(`Unexpected DuckDB version ${engine_version}. Reload the complete application release.`);
  } finally { clearTimeout(startup); }
}

export async function loadCatalog() {
  const response = await fetch(`${ARCHIVE}inventory.json`, {signal: AbortSignal.timeout(15_000), credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-cache'});
  if (!response.ok) throw new Error(`The archive catalog returned HTTP ${response.status}. Check your connection and retry.`);
  const text = await response.text();
  if (text.length > MAX_METADATA_BYTES) throw new Error('The archive catalog is larger than supported.');
  const data = JSON.parse(text);
  if (!Array.isArray(data) || data.length > 5000) throw new Error('The archive catalog has an unexpected shape.');
  return data;
}

export async function prepareArchive(selection, progress) {
  validateManifest(selection.files);
  cancelArchive();
  const current = begin();
  current.progress = progress;
  progress('Checking archive availability and download size…');
  const files = [];
  // Four concurrent metadata requests at most; no raw Parquet is read until the sum passes.
  for (let i = 0; i < selection.files.length; i += 4) {
    files.push(...await Promise.all(selection.files.slice(i, i + 4).map(async file => {
      const response = await fetchArchive(file.url, current, {method: 'HEAD'});
      if (response.status === 404) return {...file, bytes: 0, status: 'missing'};
      if (!response.ok) throw new Error(`Archive ${file.date} returned HTTP ${response.status}. This is an access or network error, not evidence of no transit service.`);
      const length = response.headers.get('content-length');
      const bytes = Number(length);
      if (!length || !Number.isSafeInteger(bytes) || bytes <= 0) throw new Error(`The size of ${file.date} is unavailable. This selection cannot be checked against the browser budget.`);
      return {...file, bytes, status: 'available'};
    })));
  }
  enforceObjectBudget(files);
  await initialize(current);
  progress('Inspecting the available Parquet schema…');
  for (const file of files.filter(file => file.status === 'available')) {
    await guard(db.registerFileURL(file.alias, file.url, duckdb.DuckDBDataProtocol.HTTP, false), current);
  }
  const aliases = files.filter(file => file.status === 'available').map(file => `'${file.alias}'`).join(', ');
  const schema = await query(`DESCRIBE SELECT * FROM read_parquet([${aliases}], union_by_name = true, hive_partitioning = false)`, current);
  const warnings = [];
  let metadata = [];
  let schedules = [];
  try {
    progress('Looking up historical route and mode metadata…');
    const response = await fetchArchive(`${ARCHIVE}feeds.parquet`, current, {method: 'HEAD'});
    const bytes = Number(response.headers.get('content-length'));
    if (!response.ok || !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_METADATA_BYTES) throw new Error('Feed metadata cannot be checked within its 2 MiB budget.');
    await guard(db.registerFileURL('feeds.parquet', `${ARCHIVE}feeds.parquet`, duckdb.DuckDBDataProtocol.HTTP, false), current);
    const statement = await guard(connection.prepare("SELECT schedule_urls, schedule_url, interval_seconds FROM read_parquet('feeds.parquet') WHERE base64url = ? AND feed_type = 'vehicle_positions'"), current);
    try { metadata = plainRows(await guard(statement.query(selection.feed.base64url), current)); }
    finally { await guard(statement.close(), current); }
    const responseSchedules = await fetchArchive(`${ARCHIVE}schedules.json`, current);
    if (!responseSchedules.ok) throw new Error(`Schedule catalog HTTP ${responseSchedules.status}.`);
    const text = await responseSchedules.text();
    if (text.length > MAX_METADATA_BYTES) throw new Error('The schedule catalog exceeds the metadata budget.');
    schedules = JSON.parse(text);
    if (!Array.isArray(schedules)) throw new Error('Invalid schedule catalog.');
  } catch (error) {
    current.controller.signal.throwIfAborted();
    warnings.push(`Route names and mode metadata could not be loaded: ${error.message}`);
  }
  return {files, columns: schema.map(row => row.column_name), engine_version: 'v2.0.0', checked_at: new Date().toISOString(), metadata, schedules, warnings};
}

export async function loadRoutes(choice) {
  const current = operation;
  if (!current) throw new Error('Load an archive before its route metadata.');
  const url = validateArchiveURL(choice.url);
  if (!/^https:\/\/storage\.googleapis\.com\/parquet\.gtfsrt\.io\/schedules\/base64url=[A-Za-z0-9_-]+\/_feed_digest=v1:[a-fA-F0-9]{64}\/routes\.parquet$/.test(url)) throw new Error('Invalid historical route metadata URL.');
  const response = await fetchArchive(url, current, {method: 'HEAD'});
  const bytes = Number(response.headers.get('content-length'));
  if (!response.ok || !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_METADATA_BYTES) throw new Error('Historical routes are unavailable within the 2 MiB metadata budget.');
  await guard(db.registerFileURL('routes.parquet', url, duckdb.DuckDBDataProtocol.HTTP, false), current);
  const rows = await query("SELECT CAST(route_id AS VARCHAR) AS route_id, CAST(route_short_name AS VARCHAR) AS route_short_name, CAST(route_long_name AS VARCHAR) AS route_long_name, TRY_CAST(route_type AS INTEGER) AS route_type FROM read_parquet('routes.parquet') LIMIT 5001", current);
  if (rows.length > 5000 || new Set(rows.map(row => row.route_id)).size !== rows.length) throw new Error('Route metadata is oversized or has ambiguous route IDs.');
  return rows;
}

export async function runQueries(normalize, queries, progress) {
  const current = operation ?? begin();
  current.progress = progress;
  if (!connection) throw new Error('The local database was cleared. Load the archive again.');
  const started = performance.now();
  if (normalize) {
    progress('Reading the selected archive into your local database…');
    await query(normalize, current);
  }
  const result = {};
  let rowCount = 0;
  const limits = {summary: 1, routes: 500, hours: 24, route_hours: 12000, coverage: 144, positions: 5000};
  for (const [name, sql] of queries) {
    if (!(name in limits) || name in result) throw new Error('Unknown analytical operation.');
    progress(`Calculating ${name.replaceAll('_', ' ')} locally…`);
    const rows = await query(sql, current);
    rowCount += rows.length;
    if (rows.length > limits[name] || rowCount > 20000) throw new Error('This selection exceeds the result budget. Choose a smaller feed or date range.');
    result[name] = rows;
  }
  result.elapsed_ms = performance.now() - started;
  operation = undefined;
  return result;
}

export function initialSelection() {
  const params = new URL(location.href).searchParams;
  return {feed: params.get('feed'), from: params.get('from'), to: params.get('to')};
}

export function rememberSelection(selection) {
  const url = new URL(location.href);
  url.search = '';
  url.searchParams.set('feed', selection.feed.base64url);
  url.searchParams.set('from', selection.from);
  url.searchParams.set('to', selection.to);
  history.replaceState(null, '', url);
}

export function downloadFile(name, content, type) {
  const blob = new Blob([content], {type});
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copyLink() {
  await navigator.clipboard.writeText(location.href);
}

addEventListener('pagehide', () => cancelArchive());
