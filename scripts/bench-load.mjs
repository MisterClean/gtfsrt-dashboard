// Cold-load benchmark: how long one service day of an agency takes to appear, and where
// the time goes. Each feed gets a brand new browser profile, so nothing is cached, and
// the page is the built release, served by scripts/serve.mjs with its production headers.
//
//   npm run build                       (or: node node_modules/vite/bin/vite.js build)
//   CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
//     node scripts/bench-load.mjs --feeds metro-transit-madison,metrolink --date 2026-11-06
//
// Options
//   --feeds a,b     agency_id (or agency_id/system_id, e.g. mta/bus), or a base64url key
//   --date D        the service day, default: the second-to-last day every listed feed has
//   --runs N        repeats per feed, default 1; the median is reported
//   --json FILE     also write every run's raw numbers
//   --port N        port for the local server, default 4190
//   --headed        show the browser
//   --trace         also write every archive GET (url, byte range, size, time) next to --json
//
// What it reports per feed: wall time from Analyze to results, and the stages the worker
// timed (src/engine/worker.ts, Run.span). Stage times can overlap once work is
// parallel, so they are windows ("started at, took"), not a sum. Network figures count
// requests to the archive that the browser made, with bytes from each response's
// Content-Length (the length of the range, for a 206). Playwright cannot see
// bytes inside cache hits, which a cold profile has none of. "archive MB" is position
// files; "sched MB" is everything else (schedule tables, feeds.parquet, JSON).
import {spawn} from 'node:child_process';
import {mkdtemp, rm, writeFile, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {chromium} from 'playwright';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : args[at + 1];
};
const feeds = option('feeds', 'metro-transit-madison').split(',').map(value => value.trim()).filter(Boolean);
const runs = Number(option('runs', 1));
const port = Number(option('port', 4190));
const headed = args.includes('--headed');
const tracing = args.includes('--trace');
const base = `http://127.0.0.1:${port}/gtfsrt-dashboard/`;
const ARCHIVE = 'https://storage.googleapis.com/parquet.gtfsrt.io/';

try {
  await access(resolve(root, 'dist/index.html'));
} catch {
  console.error('There is no build in dist/. Run "npm run build" first (or "node node_modules/vite/bin/vite.js build" when the engine is already compiled).');
  process.exit(1);
}

const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const secs = ms => (ms / 1000).toFixed(1);

async function measure(feed, date, trace) {
  const profile = await mkdtemp(join(tmpdir(), 'transit-bench-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      headless: !headed,
      executablePath: process.env.CHROME_PATH || undefined,
      viewport: {width: 1440, height: 900},
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disk-cache-size=1'],
    });
    const page = context.pages()[0] ?? (await context.newPage());
    const traffic = {requests: 0, heads: 0, gets: 0, bytes: 0, scheduleBytes: 0};
    const opened = Date.now();
    context.on('response', response => {
      const url = response.url();
      if (!url.startsWith(ARCHIVE)) return;
      const method = response.request().method();
      traffic.requests += 1;
      if (method === 'HEAD') { traffic.heads += 1; return; }
      traffic.gets += 1;
      if (trace) trace.push({url: url.replace(ARCHIVE, ''), range: response.request().headers().range, status: response.status(), length: Number(response.headers()['content-length'] ?? 0), at: Date.now() - opened});
      const headers = response.headers();
      const length = Number(headers['content-length'] ?? 0);
      if (url.includes('vehicle_positions')) traffic.bytes += length;
      else traffic.scheduleBytes += length;
    });

    await page.goto(base);
    await page.waitForFunction(() => window.__transit?.feeds.length > 0 && window.__transit.dates.length >= 0, null, {timeout: 60000});
    const catalogSeconds = (Date.now() - opened) / 1000;
    const found = await page.evaluate(({feed, date}) => {
      const app = window.__transit;
      const [agency, system] = feed.split('/');
      const match = app.feeds.find(f => f.base64url === feed)
        ?? app.feeds.find(f => f.agency_id === agency && (system ? f.system_id === system : true) && f.feed_type === 'vehicle_positions');
      if (!match) return null;
      const day = Number(date.replaceAll('-', ''));
      app.selectFeed(match.base64url, [day]);
      return {key: match.base64url, label: match.system_name ?? match.agency_name, dateMin: match.date_min, dateMax: match.date_max};
    }, {feed, date});
    if (!found) throw new Error(`No feed "${feed}" in the catalog`);
    await page.waitForFunction(key => window.__transit.feedKey === key && window.__transit.dates.length > 0 && !window.__transit.running, found.key, {timeout: 60000});
    // Count only what Analyze causes, not the page's own start-up.
    for (const key of Object.keys(traffic)) traffic[key] = 0;

    const started = Date.now();
    await page.evaluate(() => { window.__transit.analyze(); });
    await page.waitForFunction(() => (window.__transit.result !== null || window.__transit.error !== null) && !window.__transit.running, null, {timeout: 900000, polling: 250});
    const wall = Date.now() - started;
    const outcome = await page.evaluate(() => {
      const app = window.__transit;
      return {error: app.error, result: app.result, reads: app.reads.map(r => ({bytes: r.bytes, rows: r.rows, seconds: r.seconds})), notes: app.overview?.days?.map(d => d.warnings) ?? []};
    });
    if (outcome.error) throw new Error(`Analysis failed: ${outcome.error}`);
    return {
      feed, label: found.label, date, wall, catalogSeconds, traffic: {...traffic},
      timings: outcome.result?.timings ?? [], reads: outcome.reads,
      analyzed: outcome.result?.analyzed?.length ?? 0, unavailable: outcome.result?.unavailable ?? [],
    };
  } finally {
    await context?.close();
    await rm(profile, {recursive: true, force: true});
  }
}

// A date every requested feed has: the day before yesterday in UTC, which is complete.
const date = option('date', new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10));

const server = spawn(process.execPath, [resolve(root, 'scripts/serve.mjs')], {env: {...process.env, PORT: String(port)}, stdio: 'ignore'});
const all = [];
const traces = {};
try {
  await new Promise(done => setTimeout(done, 600));
  for (const feed of feeds) {
    const samples = [];
    for (let run = 1; run <= runs; run++) {
      process.stderr.write(`${feed} run ${run}/${runs} ... `);
      try {
        const sample = await measure(feed, date, tracing ? (traces[feed] = []) : null);
        samples.push(sample);
        process.stderr.write(`${secs(sample.wall)} s\n`);
      } catch (error) {
        process.stderr.write(`failed: ${error.message}\n`);
      }
    }
    if (samples.length) all.push({feed, samples});
  }
} finally {
  server.kill();
}

// ---- Report ----------------------------------------------------------------

const MB = 1024 * 1024;
const stageNames = ['database', 'feeds.parquet', 'schedules.json', 'timezone', 'sizes', 'schedule'];
console.log(`\nCold load of ${date}, ${runs} run(s) per feed. Seconds unless noted.\n`);
const header = ['feed', 'total', ...stageNames, 'files', 'process', 'archive MB', 'sched MB', 'GETs', 'HEADs'];
const rows = all.map(({feed, samples}) => {
  const best = samples.slice().sort((a, b) => a.wall - b.wall)[Math.floor((samples.length - 1) / 2)];
  const byName = name => best.timings.filter(span => span.name === name);
  const sum = spans => spans.reduce((total, span) => total + (span.end - span.start), 0);
  const files = best.timings.filter(span => /^file \S+$/.test(span.name));
  const process_ = best.timings.filter(span => span.name.startsWith('process '));
  return [
    feed, secs(median(samples.map(s => s.wall))),
    ...stageNames.map(name => secs(sum(byName(name)))),
    secs(sum(files)), secs(sum(process_)),
    (best.traffic.bytes / MB).toFixed(0), (best.traffic.scheduleBytes / MB).toFixed(1), best.traffic.gets, best.traffic.heads,
  ];
});
const widths = header.map((name, i) => Math.max(name.length, ...rows.map(row => String(row[i]).length)));
const line = cells => cells.map((cell, i) => String(cell).padEnd(widths[i])).join('  ');
console.log(line(header));
console.log(line(widths.map(width => '-'.repeat(width))));
for (const row of rows) console.log(line(row));

console.log('\nStage windows for the median run (start -> end, seconds from Analyze):');
for (const {feed, samples} of all) {
  const best = samples.slice().sort((a, b) => a.wall - b.wall)[Math.floor((samples.length - 1) / 2)];
  console.log(`\n${feed} (${best.label})`);
  for (const span of best.timings.slice().sort((a, b) => a.start - b.start)) {
    console.log(`  ${String(span.name).padEnd(34)} ${secs(span.start).padStart(6)} -> ${secs(span.end).padStart(6)}  (${secs(span.end - span.start)} s)`);
  }
}

const out = option('json', null);
if (out) await writeFile(out, JSON.stringify(tracing ? {all, traces} : all, null, 2));
