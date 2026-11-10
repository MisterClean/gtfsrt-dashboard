import assert from 'node:assert/strict';
import {test} from 'node:test';
import {gzipSync} from 'node:zlib';
import {CTA_ROUTE_MATCH_MIN, readSnapshotLocation, SnapshotClient, snapshotHash} from '../src/lib/snapshot.ts';
import {coverageOf, withMatchRate} from '../src/lib/stats.ts';

const indexUrl = new URL('https://example.test/report/snapshot/index.json');
const date = '2026-11-09';
const manifest = {
  version: 1,
  requestedDates: [date],
  overview: {dates: [date], days: []},
  routes: [{id: '49'}],
  details: {'49': 'routes/49.json'},
};

test('snapshot links preserve route IDs and tolerate missing or malformed hashes', () => {
  assert.deepEqual(readSnapshotLocation(snapshotHash('route', '49/X')), {view: 'route', routeId: '49/X'});
  assert.deepEqual(readSnapshotLocation('#data'), {view: 'data', routeId: null});
  for (const hash of ['', '#route/', '#route/%', '#overview']) {
    assert.deepEqual(readSnapshotLocation(hash), {view: 'routes', routeId: null});
  }
});

test('route and compressed trip reports load on demand and can be reused', async t => {
  const report = {route: {score: {id: '49'}}, map: {features: []}, lines: 'lines/49.json.gz'};
  const result = {available: true, line: null};
  const lines = {'0': {[date]: result}};
  const files = new Map([
    [indexUrl.href, () => Response.json(manifest)],
    [new URL('routes/49.json', indexUrl).href, () => Response.json(report)],
    [new URL('lines/49.json.gz', indexUrl).href, () => new Response(gzipSync(JSON.stringify(lines)))],
  ]);
  const fetch = t.mock.method(globalThis, 'fetch', async url => files.get(url.href)?.() ?? new Response('', {status: 404}));
  const client = await SnapshotClient.open(indexUrl);

  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(await client.route('49'), report);
  assert.equal(fetch.mock.callCount(), 2);
  assert.deepEqual(await client.stringLine('49', 0, date), result);
  assert.deepEqual(await client.stringLine('49', 1, date), {available: false, line: null});
  assert.equal(await client.route('unknown'), null);
  assert.equal(fetch.mock.callCount(), 3);
});

test('snapshot retry handles a failed companion request and transparently decoded gzip', async t => {
  let attempts = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    if (url.href === indexUrl.href) return Response.json(manifest);
    if (url.pathname.endsWith('/routes/49.json')) return Response.json({lines: 'lines/49.json.gz'});
    if (++attempts === 1) return new Response(null, {status: 503});
    return Response.json({'1': {[date]: {available: true, line: null}}});
  });
  const client = await SnapshotClient.open(indexUrl);

  await assert.rejects(client.stringLine('49', 1, date), /HTTP 503/);
  assert.deepEqual(await client.stringLine('49', 1, date), {available: true, line: null});
});

test('packed trip reports reconstruct exact scheduled and observed points', async t => {
  const line = {date, route: '49', dir: 1, length_m: 103.12, stops: [[0, 'Start'], [103.12, 'End']]};
  const packed = {
    version: 1,
    distances: [0, 62.75, 103.12],
    directions: {
      '1': {
        [date]: {available: true, line: {...line, trips: [
          ['first', '102', -20, [3600, -15, 0, 32, -20, 2]],
          ['second', '304', null, [3675, 5, 1, 18, 8, 1]],
        ]}},
      },
    },
  };
  t.mock.method(globalThis, 'fetch', async url => {
    if (url.href === indexUrl.href) return Response.json(manifest);
    if (url.pathname.endsWith('/routes/49.json')) return Response.json({lines: 'lines/49.json.gz'});
    return new Response(gzipSync(JSON.stringify(packed)));
  });
  const client = await SnapshotClient.open(indexUrl);
  assert.deepEqual(await client.stringLine('49', 1, date), {available: true, line: {...line, trips: [
    {trip_id: 'first', vehicle: '102', deviation_end_s: -20, scheduled: [[3600, 0], [3632, 103.12]], observed: [[3585, 0], [3612, 103.12]]},
    {trip_id: 'second', vehicle: '304', deviation_end_s: null, scheduled: [[3675, 62.75], [3693, 103.12]], observed: [[3680, 62.75], [3701, 103.12]]},
  ]}});
  assert.deepEqual(await client.stringLine('49', 0, date), {available: false, line: null});
});

test('report references cannot fetch outside the snapshot directory', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({
    ...manifest,
    details: {'49': '../outside.json'},
  }));
  const client = await SnapshotClient.open(indexUrl);
  await assert.rejects(client.route('49'), /outside its data directory/);
  assert.equal(fetch.mock.callCount(), 1);
});

test('the lower of systemwide daily and route match rates determines coverage', () => {
  const dailyCoverage = (...rates) => coverageOf({days: rates.map(trip_match => ({
    trips_scheduled: 50,
    on_time: {total: 30},
    trip_match,
  }))});
  const wellCovered = dailyCoverage(0.83, 0.95);
  const thinDay = dailyCoverage(0.23, 0.95);
  assert.equal(withMatchRate(wellCovered, 0.5).mode, 'partial');
  assert.equal(withMatchRate(wellCovered, 0.49, CTA_ROUTE_MATCH_MIN).mode, 'suppressed');
  assert.equal(withMatchRate(wellCovered, 0.5, CTA_ROUTE_MATCH_MIN).mode, 'partial');
  assert.equal(withMatchRate(wellCovered, 0.23).mode, 'suppressed');
  assert.equal(withMatchRate(thinDay, 0.95).mode, 'suppressed');
  assert.equal(withMatchRate(thinDay, 0.95).matchRate, 0.23);
  assert.equal(withMatchRate(wellCovered, undefined), wellCovered);
});
