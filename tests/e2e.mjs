// End-to-end check of the built release against the live archive. Run after
// `npm run build`:
//
//   npm run test:e2e                 (uses Playwright's Chromium)
//   CHROME_PATH=/path/to/chrome npm run test:e2e
//
// Proves what the architecture promises: the page runs under the production
// security policy, every report renders, and the browser talks to nobody except
// this host, the public archives and the optional basemap.
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
const CTA_DAY = process.env.E2E_CTA_DATE || '2026-11-02';
const CTA_ARCHIVE = 'https://data.chicagotransitalerts.app/positions/';
const ALLOWED = [
  `http://127.0.0.1:${port}/`,
  'https://storage.googleapis.com/parquet.gtfsrt.io/',
  'https://tiles.openfreemap.org/',
  CTA_ARCHIVE,
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
  const positionRequests = [];
  page.on('console', message => {
    if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) problems.push(message.text().slice(0, 300));
  });
  page.on('pageerror', error => problems.push(`uncaught: ${error.message.slice(0, 300)}`));
  context.on('request', request => {
    const url = request.url();
    if (url.startsWith('http')) contacted.add(url);
    if (url.startsWith(CTA_ARCHIVE) && url.endsWith('.parquet')) positionRequests.push(request);
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

  // Regression: switching agency during a restore once showed one agency's numbers
  // under another's name.
  await page.waitForFunction(() => window.__transit.routes.length > 0, null, {timeout: 30000, polling: 50});
  const madisonRoutes = await page.evaluate(() => window.__transit.routes.map(route => route.label).join());
  await page.reload();
  await page.waitForFunction(() => window.__transit?.feeds.length > 0 && window.__transit.running, null, {timeout: 30000, polling: 10});
  const other = await page.evaluate(() => {
    const app = window.__transit;
    const feed = app.feeds.find(candidate => candidate.agency_id === 'mountain-line-missoula') ?? app.feeds.find(candidate => candidate.base64url !== app.feedKey);
    app.selectFeed(feed.base64url, null);
    return feed.base64url;
  });
  await page.waitForFunction(key => window.__transit.feedKey === key && !window.__transit.running, other, {timeout: 30000, polling: 100});
  await page.waitForTimeout(500);
  const afterSwitch = await page.evaluate(() => {
    const app = window.__transit;
    return {analyzed: app.analyzedDates.length, overview: app.overview, routes: app.routes.map(route => route.label).join(), error: app.error};
  });
  assert.equal(afterSwitch.overview, null, 'the previous agency\'s results are gone');
  assert.equal(afterSwitch.analyzed, 0, 'nothing from the previous agency is marked as analyzed');
  assert.notEqual(afterSwitch.routes, madisonRoutes);
  assert.equal(afterSwitch.error, null);

  // Regression: Stop once left the analysis hanging, or let it resume into the next run.
  const stopping = Date.now();
  await page.evaluate(() => { window.__transit.analyze(); });
  await page.waitForFunction(() => /Reading|Checking/.test(window.__transit.stage?.message ?? ''), null, {timeout: 60000, polling: 50});
  await page.evaluate(() => window.__transit.stop());
  await page.waitForFunction(() => !window.__transit.running, null, {timeout: 5000, polling: 50});
  const stopped = await page.evaluate(() => ({error: window.__transit.error, result: window.__transit.result}));
  assert.equal(stopped.error, null, 'stopping is not an error');
  assert.equal(stopped.result?.stopped, true);
  console.log(`Stop settled ${Date.now() - stopping} ms after the run began.`);

  // And the feed can still be analyzed afterwards.
  await page.evaluate(() => { const app = window.__transit; app.setDates(app.dates.slice(-1)); return app.analyze(); });
  await page.waitForFunction(() => window.__transit.hasResults && !window.__transit.running, null, {timeout: 180000, polling: 200});
  assert.equal(await page.evaluate(() => window.__transit.error), null, 'a stopped feed analyzes cleanly afterwards');

  for (const [suffix, mode] of [['bus', 'Bus'], ['rail', 'Rail']]) {
    const feed = `chicago-transit-alerts-${suffix}`;
    const before = positionRequests.length;
    await page.goto(`${base}?feed=${feed}&from=${CTA_DAY}&to=${CTA_DAY}`);
    await page.waitForFunction(key => window.__transit?.feedKey === key && window.__transit.dates.length === 1, feed, {timeout: 45000});
    assert.equal(positionRequests.length, before, 'CTA position files wait for Analyze');
    assert.equal(await page.getByRole('combobox', {name: 'Transit agency'}).locator('option').filter({hasText: 'Chicago Transit Alerts'}).count(), 2);
    const started = Date.now();
    await page.getByRole('button', {name: /^Analyze 1 day$/}).first().click();
    await page.waitForFunction(() => !window.__transit.running && (window.__transit.overview || window.__transit.error), null, {timeout: 120000});
    const cta = await page.evaluate(() => {
      const app = window.__transit;
      return {
        error: app.error, speed: app.overview?.speed, trips: app.overview?.trips_scheduled_per_day,
        modes: [...new Set(app.routes.map(route => route.mode))], routes: app.routes.length,
        analyzed: app.result?.analyzed, reads: app.reads,
        days: Object.values(app.positionDays), quality: app.quality?.days[0],
      };
    });
    assert.equal(cta.error, null);
    assert.ok(cta.speed > 2 && cta.speed < 25, `${mode} speed ${cta.speed} m/s is plausible`);
    assert.equal(cta.trips, 0);
    assert.deepEqual(cta.modes, [mode]);
    assert.ok(cta.routes >= (mode === 'Bus' ? 100 : 8));
    assert.equal(cta.quality.status, 'Complete');
    assert.ok(cta.quality.quality.pairs_kept > 1000);
    assert.equal(cta.analyzed.length, 1);
    const [day] = cta.days;
    assert.match(day.manifest, /^[a-f0-9]{64}$/);
    assert.equal(day.timezone, 'America/Chicago');
    assert.equal(day.files.length, 2);
    assert.ok(day.files.every(file => !file.missing && /^[a-f0-9]{64}$/.test(file.sha256)));
    const reads = positionRequests.slice(before);
    assert.equal(reads.length, 2, 'each partition is fetched once');
    for (const request of reads) assert.equal((await request.response()).status(), 200);
    const bytes = cta.reads.reduce((sum, read) => sum + read.bytes, 0);
    assert.ok(bytes > 0 && bytes < 64 * 1024 * 1024);

    await page.evaluate(() => window.__transit.go('reliability'));
    await page.getByText('This report needs positions linked to scheduled trips.', {exact: false}).waitFor();
    await page.getByRole('button', {name: 'Open Data & methods'}).click();
    await page.getByRole('heading', {name: 'Position archive revisions'}).waitFor();
    const pinned = page.getByRole('link', {name: 'Open this selection with the manifest pinned'});
    assert.equal(new URL(await pinned.getAttribute('href')).searchParams.get('manifest'), day.manifest);
    await pinned.click();
    await page.waitForFunction(() => window.__transit?.hasResults && !window.__transit.running, null, {timeout: 45000});
    assert.equal(positionRequests.length, before + reads.length, 'the pinned visit reuses unchanged input revisions');
    assert.equal(await page.evaluate(() => window.__transit.result?.cached.length), 1);
    console.log(`CTA ${mode.toLowerCase()}: ${cta.routes} routes, ${(cta.speed * 2.23694).toFixed(1)} mph, ${(bytes / 1048576).toFixed(1)} MiB in ${((Date.now() - started) / 1000).toFixed(1)} s including the pinned reload.`);
  }

  const outsiders = [...contacted].filter(url => !ALLOWED.some(prefix => url.startsWith(prefix)));
  assert.deepEqual(outsiders, [], 'the browser contacted only this host, the archives and the basemap');
  assert.deepEqual(problems, [], 'no console errors or policy violations');

  console.log(`Passed: one service day analysed in ${seconds} s. ${result.observed} of ${result.scheduled} trips observed at ${(result.speed * 2.23694).toFixed(1)} mph.`);
  console.log(`Contacted ${new Set([...contacted].map(url => new URL(url).host)).size} hosts: ${[...new Set([...contacted].map(url => new URL(url).host))].join(', ')}`);
} finally {
  await context?.close();
  server.kill();
  await rm(profile, {recursive: true, force: true});
}
