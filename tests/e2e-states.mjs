// End-to-end check of the page's state machines against the live archive: startup, the
// life of a day, a run that is stopped, a run that fails, and what the page says about
// each. Run after `npm run build`:
//
//   npm run test:e2e:states
//   CHROME_PATH=/path/to/chrome npm run test:e2e:states
//
// The browser reaches the archive through a small local proxy that this script can
// switch off, which is the only dependable way to cut the connection for the workers too.
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {connect} from 'node:net';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {chromium} from 'playwright';

const root = resolve(import.meta.dirname, '..');
const port = Number(process.env.PORT || 4178);
const base = `http://127.0.0.1:${port}/gtfsrt-dashboard/`;
const MADISON = 'aHR0cHM6Ly9tZXRyb21hcC5jaXR5b2ZtYWRpc29uLmNvbS9ndGZzcnQvdmVoaWNsZXM';

// ---- A proxy with a switch ---------------------------------------------------
const tunnels = new Set();
let online = true;
const proxy = createServer((_, response) => response.writeHead(502).end());
proxy.on('connect', (request, client) => {
  if (!online) return client.destroy();
  const [host, hostPort] = request.url.split(':');
  const upstream = connect(Number(hostPort) || 443, host, () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    upstream.pipe(client);
    client.pipe(upstream);
  });
  const pair = [client, upstream];
  tunnels.add(pair);
  const close = () => { tunnels.delete(pair); client.destroy(); upstream.destroy(); };
  client.on('error', close); upstream.on('error', close); client.on('close', close); upstream.on('close', close);
});
await new Promise(done => proxy.listen(0, '127.0.0.1', done));
function setOnline(value) {
  online = value;
  if (!value) for (const [client, upstream] of [...tunnels]) { client.destroy(); upstream.destroy(); }
}

const server = spawn(process.execPath, [resolve(root, 'scripts/serve.mjs')], {env: {...process.env, PORT: String(port)}, stdio: 'ignore'});
const profile = await mkdtemp(join(tmpdir(), 'transit-states-'));
let context;
let step = 'starting';
const say = message => { step = message; console.log(`· ${message}`); };

try {
  await new Promise(done => setTimeout(done, 500));
  context = await chromium.launchPersistentContext(profile, {
    headless: true,
    executablePath: process.env.CHROME_PATH || undefined,
    viewport: {width: 1440, height: 900},
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', `--proxy-server=http://127.0.0.1:${proxy.address().port}`],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  const uncaught = [];
  page.on('pageerror', error => uncaught.push(error.message.slice(0, 300)));
  // Anything the page ever shows, however briefly, that it should never show.
  await page.addInitScript(() => {
    window.__seen = {zeroDays: false, boot: []};
    new MutationObserver(() => {
      const main = document.querySelector('main');
      if (!main) return;
      if (/Analyze 0 days/.test(main.textContent)) window.__seen.zeroDays = true;
      const boot = main.querySelector('[data-boot]')?.getAttribute('data-boot');
      if (boot && window.__seen.boot.at(-1) !== boot) window.__seen.boot.push(boot);
    }).observe(document, {childList: true, subtree: true, characterData: true});
  });

  const app = fn => page.evaluate(fn);
  const state = () => page.evaluate(() => {
    const a = window.__transit;
    return {run: JSON.parse(JSON.stringify(a.run, (key, value) => (key === 'failure' ? {kind: value.kind, context: value.context} : value))),
      days: a.days, dates: a.dates, loaded: a.loadedDates, pending: a.pendingDates, running: a.running, error: a.error, boot: a.boot.step};
  });
  const idle = (timeout = 240000) => page.waitForFunction(() => !window.__transit.running, null, {timeout, polling: 100});
  const reading = () => page.waitForFunction(() => /Reading|Downloading/.test(window.__transit.stage?.message ?? ''), null, {timeout: 90000, polling: 25});
  const notice = kind => page.locator(`[data-run="${kind}"]`);
  const mainText = async () => (await page.locator('main').innerText()).replace(/\s+/g, ' ');

  // ---- Startup ---------------------------------------------------------------
  say('startup with the archive unreachable fails at the catalog step, and says so');
  setOnline(false);
  await page.goto(base);
  await page.waitForFunction(() => window.__transit?.boot.step === 'failed', null, {timeout: 120000});
  let boot = await app(() => ({at: window.__transit.boot.at, kind: window.__transit.boot.failure.kind, context: window.__transit.boot.failure.context}));
  assert.equal(boot.at, 'catalog');
  assert.equal(boot.context, 'loading the archive catalog');
  assert.match(await mainText(), /agency list comes from the archive/);
  assert.equal(await page.locator('main button.primary').count(), 0, 'no Analyze button while startup has failed');

  say('Try again recovers once the archive is back');
  setOnline(true);
  await page.getByRole('button', {name: 'Try again'}).click();
  await page.waitForFunction(() => window.__transit.boot.step === 'ready' && window.__transit.dates.length > 0, null, {timeout: 120000});
  assert.equal(await page.locator('main .banner.error').count(), 0, 'the startup failure notice is gone');

  say('a normal startup names its steps and never offers to analyze 0 days');
  await page.goto(`${base}?feed=${MADISON}`);
  await page.waitForFunction(() => window.__transit?.boot.step === 'ready' && window.__transit.dates.length > 0, null, {timeout: 120000});
  const seen = await app(() => window.__seen);
  assert.equal(seen.zeroDays, false, 'the page never said "Analyze 0 days"');
  assert.ok(seen.boot.length >= 1 && seen.boot.every(s => ['engine', 'catalog', 'opening'].includes(s)), `startup steps shown: ${seen.boot}`);
  assert.deepEqual([...seen.boot].sort((a, b) => ['engine', 'catalog', 'opening'].indexOf(a) - ['engine', 'catalog', 'opening'].indexOf(b)), seen.boot, 'steps appear in order');
  const [dayA, dayB, dayC, dayD] = await app(() => window.__transit.dates.slice(0, 4));
  assert.ok(dayD, 'the default selection has at least four days to work with');

  // ---- The life of a day -------------------------------------------------------
  say('one fresh day goes queued, reading, analyzing, loaded, and ends up saved');
  await app(() => { window.__transit.setDates([window.__transit.dates[0]]); });
  await app(() => {
    const a = window.__transit;
    const date = a.dates[0];
    window.__trail = [];
    const timer = setInterval(() => {
      const status = a.days[date]?.status ?? 'idle';
      if (window.__trail.at(-1) !== status) window.__trail.push(status);
      if (!a.running && status === 'loaded') clearInterval(timer);
    }, 10);
  });
  await page.locator('header .status button.primary').click();
  await page.waitForFunction(() => window.__transit.hasResults && !window.__transit.running, null, {timeout: 300000, polling: 100});
  const trail = await app(() => window.__trail);
  const order = ['idle', 'queued', 'reading', 'analyzing', 'loaded'];
  assert.deepEqual([...trail].sort((a, b) => order.indexOf(a) - order.indexOf(b)), trail, `statuses in order: ${trail}`);
  assert.ok(trail.includes('queued') && trail.includes('reading') && trail.at(-1) === 'loaded', `statuses seen: ${trail}`);
  let s = await state();
  assert.deepEqual(s.days[dayA], {status: 'loaded', saved: true, partial: false, fromDevice: false, reason: null});
  assert.equal(s.run.phase, 'idle');
  assert.equal(await notice('failed').count() + await notice('stopped').count(), 0);

  say('every view draws from the shared loader without an error');
  for (const view of ['overview', 'map', 'routes', 'reliability', 'stops', 'hotspots', 'data']) {
    await app(next => window.__transit.go(next), view).catch(() => {});
    await page.evaluate(next => window.__transit.go(next), view);
    await page.waitForTimeout(700);
    assert.equal(await page.locator('main .banner.error').count(), 0, `${view} shows no error`);
    assert.doesNotMatch(await mainText(), /Calculating…/, `${view} finished calculating`);
  }
  say('the Data page states how the day was measured');
  assert.match((await page.locator('[data-methods]').innerText()).replace(/\s+/g, ' '), /How they were measured Schedule/);
  assert.equal(await page.locator('[data-method="schedule"], [data-method="schedule_later"]').count(), 1);
  assert.equal(await app(() => window.__transit.overview.days[0].method), await app(() => window.__transit.quality.days[0].method));

  say('one route\'s report is never shown under another route\'s name');
  const routes = await app(() => window.__transit.routes.slice(0, 2).map(r => ({id: r.id, label: r.label})));
  await page.evaluate(id => window.__transit.go('route', id), routes[0].id);
  await page.waitForFunction(label => document.querySelector('main h1')?.textContent.includes(label), routes[0].label, {timeout: 20000});
  await page.evaluate(id => {
    window.__wrong = false;
    const check = () => { if (window.__transit.routeId === id && document.querySelector('main h1') && !document.querySelector('main h1').textContent.includes(window.__label)) window.__wrong = true; };
    new MutationObserver(check).observe(document.querySelector('main'), {childList: true, subtree: true, characterData: true});
  }, routes[1].id);
  await page.evaluate(([id, label]) => { window.__label = label; window.__transit.go('route', id); }, [routes[1].id, routes[1].label]);
  await page.waitForFunction(label => document.querySelector('main h1')?.textContent.includes(label), routes[1].label, {timeout: 20000});
  assert.equal(await app(() => window.__wrong), false, 'the old route\'s heading never showed while the new route was selected');
  await page.evaluate(() => window.__transit.go('overview'));

  // ---- A saved day picked while another is running ------------------------------
  say('after a reload, a saved day that is selected loads by itself');
  await page.reload();
  await page.waitForFunction(() => window.__transit?.hasResults && !window.__transit.running, null, {timeout: 60000});
  s = await state();
  assert.equal(s.days[dayA].fromDevice, true);

  say('a saved day added during a run waits, says so, then loads without a click');
  await page.goto(`${base}?feed=${MADISON}&from=${iso(dayB)}&to=${iso(dayB)}`);
  await page.waitForFunction(() => window.__transit?.boot.step === 'ready', null, {timeout: 60000});
  s = await state();
  assert.deepEqual(s.days[dayA], {status: 'idle', saved: true, partial: false, fromDevice: false, reason: null}, 'saved, not loaded, not selected');
  await app(() => { window.__transit.analyze(); });
  await reading();
  await page.evaluate(([a, b]) => window.__transit.setDates([a, b]), [dayA, dayB]);
  s = await state();
  assert.equal(s.days[dayA].status, 'queued');
  assert.deepEqual(s.run.dates, [dayB], 'the run itself is unchanged');
  assert.match(await mainText(), /already on this device and will load when this finishes/);
  await page.waitForFunction(() => !window.__transit.running && window.__transit.loadedDates.length === 2, null, {timeout: 240000, polling: 100});
  s = await state();
  assert.deepEqual(s.pending, [], 'nothing is left asking for a click');
  assert.equal(s.days[dayA].fromDevice, true);
  assert.match(await page.locator('header .status').innerText(), /Analyzed on this device/);
  assert.equal(await page.locator('header .status button.primary').count(), 0, 'no Analyze button is offered');

  say('a saved day deselected while it waits leaves the line');
  await page.goto(`${base}?feed=${MADISON}&from=${iso(dayC)}&to=${iso(dayC)}`);
  await page.waitForFunction(() => window.__transit?.boot.step === 'ready', null, {timeout: 60000});
  await app(() => { window.__transit.analyze(); });
  await reading();
  await page.evaluate(([a, c]) => { window.__transit.setDates([a, c]); window.__transit.setDates([c]); }, [dayA, dayC]);
  assert.equal((await state()).days[dayA].status, 'idle');

  // ---- Stop ---------------------------------------------------------------------
  say('Stop leaves a notice saying what was kept and what is left');
  await app(() => window.__transit.stop());
  await idle(10000);
  s = await state();
  assert.deepEqual(s.run, {phase: 'stopped', finished: 0, left: [dayC]});
  assert.equal(s.error, null, 'a stop is not an error');
  assert.equal(s.days[dayC], undefined, 'the stopped day is back to idle with nothing recorded');
  assert.match(await notice('stopped').innerText(), /Stopped\. No day had finished/);

  say('Continue finishes the stopped day and the notice goes');
  await notice('stopped').getByRole('button', {name: /Continue/}).click();
  await page.waitForFunction(() => window.__transit.hasResults && !window.__transit.running, null, {timeout: 240000, polling: 100});
  s = await state();
  assert.equal(s.run.phase, 'idle');
  assert.equal(s.days[dayC].status, 'loaded');
  assert.equal(await notice('stopped').count(), 0);

  // ---- Failure ------------------------------------------------------------------
  say('a dropped connection fails the run, names the day, and marks it in the picker');
  await page.evaluate(d => window.__transit.setDates([d]), dayD);
  await app(() => { window.__transit.analyze(); });
  await reading();
  // A saved day picked just before the failure still loads by itself afterwards.
  await page.evaluate(([a, d]) => window.__transit.setDates([a, d]), [dayA, dayD]);
  setOnline(false);
  await page.waitForFunction(() => window.__transit.run.phase === 'failed' && !window.__transit.running && window.__transit.loadedDates.length === 1, null, {timeout: 240000, polling: 100});
  s = await state();
  assert.deepEqual(s.run.left, [dayD]);
  assert.equal(s.days[dayA].status, 'loaded', 'the saved day loaded with the archive unreachable');
  assert.deepEqual(s.pending, [dayD], 'only the failed day is left to ask for');
  assert.ok(['offline', 'timeout', 'http', 'query'].includes(s.run.failure.kind), `classified as ${s.run.failure.kind}`);
  assert.equal(s.days[dayD].status, 'failed');
  assert.ok(s.days[dayD].reason, 'the day carries the reason');
  assert.ok(s.error, 'the error text is available to scripts');
  assert.match((await notice('failed').innerText()).replace(/\s+/g, ' '), new RegExp(`Not finished: ${shortDate(dayD)}\\.`));
  await page.locator('.picker .trigger').click();
  const cell = page.locator(`.days button.day[data-status="failed"]`);
  assert.equal(await cell.count(), 1);
  assert.match(await cell.getAttribute('aria-label'), /failed/);
  assert.match(await page.locator('.picker .foot').last().innerText(), /red outline: failed/);
  await page.keyboard.press('Escape');

  say('adding a saved day keeps the failure notice, since its day is still selected and still failed');
  await page.evaluate(([a, b, d]) => window.__transit.setDates([a, b, d]), [dayA, dayB, dayD]);
  await page.waitForFunction(() => !window.__transit.running && window.__transit.loadedDates.length === 2, null, {timeout: 30000, polling: 50});
  s = await state();
  assert.equal(s.run.phase, 'failed', 'the notice came back after the saved day loaded');
  assert.deepEqual(s.run.left, [dayD]);

  say('selecting other days puts the failure notice away, and the day stays marked');
  await page.evaluate(a => window.__transit.setDates([a]), dayA);
  s = await state();
  assert.equal(s.run.phase, 'idle');
  assert.equal(await notice('failed').count(), 0);
  assert.equal(s.days[dayD].status, 'failed');

  say('the retry button asks for exactly the day that failed');
  await page.evaluate(d => { window.__transit.setDates([d]); return window.__transit.analyze(); }, dayD);
  await page.waitForFunction(() => window.__transit.run.phase === 'failed', null, {timeout: 240000, polling: 100});
  setOnline(true);
  await notice('failed').getByRole('button', {name: /Try that day again/}).click();
  await page.waitForFunction(() => window.__transit.hasResults && !window.__transit.running, null, {timeout: 300000, polling: 100});
  s = await state();
  assert.equal(s.run.phase, 'idle');
  assert.equal(s.days[dayD].status, 'loaded');
  assert.equal(s.days[dayD].reason, null);
  assert.equal(s.error, null);
  assert.equal(await notice('failed').count(), 0);

  // ---- The newest day -------------------------------------------------------------
  say('the newest archive day is shown for what it is: partial, no data, or whole');
  const newest = await app(() => Number(window.__transit.feed.date_max.replaceAll('-', '')));
  await page.evaluate(d => { window.__transit.setDates([d]); return window.__transit.analyze(); }, newest);
  await idle();
  s = await state();
  const record = s.days[newest];
  console.log(`  newest day ${newest}: ${JSON.stringify(record)}`);
  if (record.status === 'no_data') {
    assert.ok(record.reason);
    assert.match(await notice('no-data').innerText(), /left out of every figure/);
    assert.deepEqual(s.pending, [], 'a day with no data is not pending');
    await notice('no-data').getByRole('button', {name: 'Check the archive again'}).click();
    await page.waitForFunction(() => window.__transit.running, null, {timeout: 10000, polling: 10}).catch(() => {});
    await idle();
    assert.ok(['no_data', 'loaded'].includes((await state()).days[newest].status), 'checking again ends in an answer');
  } else {
    assert.equal(record.status, 'loaded');
    assert.equal(record.saved, !record.partial, 'only a whole day is saved');
    await page.locator('.picker .trigger').click();
    assert.equal(await page.locator('.days button.day.partial').count(), record.partial ? 1 : 0);
    if (record.partial) assert.match(await page.locator('.picker .foot').last().innerText(), /hollow dot/);
    await page.keyboard.press('Escape');
  }

  // ---- Clearing -------------------------------------------------------------------
  say('clearing saved results resets every day and the run in one go');
  await app(() => window.__transit.clearCache());
  s = await state();
  assert.deepEqual(s.days, {});
  assert.equal(s.run.phase, 'idle');
  assert.deepEqual(s.loaded, []);

  assert.deepEqual(uncaught, [], 'no uncaught errors on the page');
  console.log('State machines verified end to end.');
} catch (error) {
  console.error(`FAILED while: ${step}`);
  throw error;
} finally {
  await context?.close();
  server.kill();
  proxy.close();
  for (const [client, upstream] of tunnels) { client.destroy(); upstream.destroy(); }
  await rm(profile, {recursive: true, force: true});
}

function iso(date) {
  return String(date).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
}
function shortDate(date) {
  return new Date(`${iso(date)}T12:00:00Z`).toLocaleDateString('en-US', {month: 'short', day: 'numeric', timeZone: 'UTC'});
}
