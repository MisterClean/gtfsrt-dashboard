// End-to-end check of the built release against the live archive. Run after
// `npm run build`:
//
//   npm run test:e2e                 (uses Playwright's Chromium)
//   CHROME_PATH=/path/to/chrome npm run test:e2e
//
// Proves what the architecture promises: the page runs under the production
// security policy, every report renders, and the browser talks to nobody except
// this host, the public archive and the optional basemap.
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {chromium} from 'playwright';

const root = resolve(import.meta.dirname, '..');
const port = Number(process.env.PORT || 4177);
const base = `http://127.0.0.1:${port}/gtfsrt-dashboard/`;
const MADISON = 'aHR0cHM6Ly9tZXRyb21hcC5jaXR5b2ZtYWRpc29uLmNvbS9ndGZzcnQvdmVoaWNsZXM';
const DAY = process.env.E2E_DATE || '2026-11-04';
const ALLOWED = [
  `http://127.0.0.1:${port}/`,
  'https://storage.googleapis.com/parquet.gtfsrt.io/',
  'https://tiles.openfreemap.org/',
];

const server = spawn(process.execPath, [resolve(root, 'scripts/serve.mjs')], {env: {...process.env, PORT: String(port)}, stdio: 'ignore'});
const profile = await mkdtemp(join(tmpdir(), 'transit-e2e-'));
let context;
try {
  await new Promise(done => setTimeout(done, 500));
  context = await chromium.launchPersistentContext(profile, {
    headless: true,
    executablePath: process.env.CHROME_PATH || undefined,
    viewport: {width: 1440, height: 900},
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  const problems = [];
  const contacted = new Set();
  page.on('console', message => {
    if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) problems.push(message.text().slice(0, 300));
  });
  page.on('pageerror', error => problems.push(`uncaught: ${error.message.slice(0, 300)}`));
  context.on('request', request => {
    const url = request.url();
    if (url.startsWith('http')) contacted.add(url);
  });

  await page.goto(`${base}?feed=${MADISON}&from=${DAY}&to=${DAY}`);
  await page.waitForFunction(() => window.__transit?.feeds.length > 0 && window.__transit.dates.length > 0, null, {timeout: 60000});

  // Nothing is downloaded until the visitor asks.
  const before = [...contacted].filter(url => url.includes('vehicle_positions'));
  assert.equal(before.length, 0, 'no archive data is read before Analyze');

  const started = Date.now();
  await page.getByRole('button', {name: /^Analyze 1 day$/}).first().click();
  await page.waitForFunction(() => window.__transit.hasResults && !window.__transit.running, null, {timeout: 300000, polling: 250});
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  const result = await page.evaluate(() => {
    const {overview: o, routes, error} = window.__transit;
    return {error, speed: o.speed, onTime: o.on_time, scheduled: o.trips_scheduled_per_day, observed: o.trips_observed_per_day, routes: routes.length};
  });
  assert.equal(result.error, null);
  assert.ok(result.speed > 4 && result.speed < 12, `network speed ${result.speed} m/s is plausible for a bus system`);
  assert.ok(result.scheduled > 1000, 'the schedule says how many trips to expect');
  assert.ok(result.observed / result.scheduled > 0.8, 'most scheduled trips are observed');
  assert.ok(result.onTime.total > 1000, 'timepoint departures were measured');
  assert.ok(result.routes > 10, 'routes are reported');

  for (const view of ['overview', 'map', 'hotspots', 'routes', 'reliability', 'stops', 'data']) {
    await page.evaluate(next => window.__transit.go(next), view);
    await page.waitForTimeout(1500);
    const heading = await page.locator('main h1').first().textContent();
    assert.ok(heading?.trim(), `${view} has a heading`);
    assert.equal(await page.locator('main .banner.error').count(), 0, `${view} shows no error`);
  }
  await page.evaluate(() => window.__transit.go('route', window.__transit.routes[0].id));
  await page.waitForTimeout(1500);
  assert.equal(await page.locator('main .banner.error').count(), 0, 'route detail shows no error');

  // A second visit reads this device's results, not the archive.
  const reads = [...contacted].filter(url => url.includes('vehicle_positions')).length;
  await page.reload();
  await page.waitForFunction(() => window.__transit?.hasResults && !window.__transit.running, null, {timeout: 60000});
  const again = [...contacted].filter(url => url.includes('vehicle_positions')).length;
  assert.equal(again, reads, 'cached days need no archive reads');

  const outsiders = [...contacted].filter(url => !ALLOWED.some(prefix => url.startsWith(prefix)));
  assert.deepEqual(outsiders, [], 'the browser contacted only this host, the archive and the basemap');
  assert.deepEqual(problems, [], 'no console errors or policy violations');

  console.log(`Passed: one service day analysed in ${seconds} s. ${result.observed} of ${result.scheduled} trips observed at ${(result.speed * 2.23694).toFixed(1)} mph.`);
  console.log(`Contacted ${new Set([...contacted].map(url => new URL(url).host)).size} hosts: ${[...new Set([...contacted].map(url => new URL(url).host))].join(', ')}`);
} finally {
  await context?.close();
  server.kill();
  await rm(profile, {recursive: true, force: true});
}
