import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadArchives, scopedFeedKey} from '../src/engine/archives.ts';
import {ARCHIVE, DEFAULT_ARCHIVE_ID} from '../src/engine/contracts.js';

const base = 'https://almanac.example/transit/';
const date = '2026-11-15';
const feed = {base64url: 'YWdlbmN5', agency_id: 'metro', feed_type: 'vehicle_positions', date_min: date, date_max: date};
const committed = {id: 'b2', label: 'GTFS-RT Archive', timezones: {metro: 'America/Chicago'}};
const root = `${base}archives/b2/compat/v1/`;
const commitUrl = `${root}commits/agency=metro/date=${date}/manifest.json`;
const partition = `vehicle_positions/date=${date}/base64url=${feed.base64url}/data.parquet`;
const generation = 'a'.repeat(64);
const key = `generations/${generation}/${partition}`;
const file = {table: 'vehicle_positions', date, canonical_key: `compat/v1/${partition}`, path: `compat/v1/${key}`, sha256: 'b'.repeat(64), bytes: 100};
const manifest = {schema_version: 1, agency: 'metro', date, generation, files: [file]};

test('registry resolves public and multiple committed archives with stable cache scopes', async t => {
  let commitReads = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(init.credentials, 'same-origin');
    assert.equal(init.redirect, 'error');
    if (url === `${base}archive-sources.json`) return Response.json([committed, {id: 'third', label: 'Third', schedules: true, signIn: true}]);
    if (url === `${root}inventory.json`) return Response.json([feed, {...feed, feed_type: 'trip_updates'}]);
    assert.equal(url, commitUrl);
    commitReads += 1;
    return Response.json(manifest);
  });

  const sources = await loadArchives(base);
  assert.deepEqual([...sources.keys()], [DEFAULT_ARCHIVE_ID, 'b2', 'third']);
  const signal = new AbortController().signal;
  const publicReader = sources.get(DEFAULT_ARCHIVE_ID).open(feed, signal);
  assert.deepEqual(await publicReader.position(date), {url: ARCHIVE + partition, credentials: 'omit'});
  const source = sources.get('b2');
  assert.equal(source.info.signInUrl, undefined);
  assert.deepEqual(await source.catalog(), [feed]);
  const reader = source.open(feed, signal);
  assert.equal(reader.timezone, 'America/Chicago');
  assert.equal(reader.schedule, null);
  const position = await reader.position(date);
  assert.deepEqual(position, {url: root + key, credentials: 'same-origin', bytes: 100, firstPartition: true});
  assert.equal(await reader.position(date), position);
  assert.equal(commitReads, 1);
  const third = sources.get('third');
  assert.equal(third.info.signInUrl, `${base}archives/third/sign-in`);
  const scheduled = third.open(feed, signal);
  assert.equal(scheduled.schedule('schedules.json').url, `${base}archives/third/compat/v1/schedules.json`);

  const cacheKeys = [...sources.keys()].map(sourceId => scopedFeedKey({sourceId, feedKey: feed.base64url}));
  assert.equal(cacheKeys[0], feed.base64url);
  assert.equal(new Set(cacheKeys).size, 3);
  assert.throws(() => scopedFeedKey({sourceId: 'b2', feedKey: '../../feed'}), /Invalid archive or feed ID/);
});

test('commits distinguish absent positions from denied requests and reject an untrusted object path', async t => {
  let respond = () => new Response(null, {status: 403});
  t.mock.method(globalThis, 'fetch', async url => {
    if (url === `${base}archive-sources.json`) return Response.json([committed]);
    assert.equal(url, commitUrl);
    return respond();
  });
  const source = (await loadArchives(base)).get('b2');
  const reader = source.open(feed, new AbortController().signal);
  await assert.rejects(reader.position(date), /HTTP 403/);
  respond = () => Response.json({...manifest, files: [{...file, path: 'https://untrusted.example/data.parquet'}]});
  await assert.rejects(reader.position(date), /invalid position object/);
  respond = () => new Response(null, {status: 404});
  assert.equal(await reader.position(date), null);
  respond = () => Response.json({...manifest, files: []});
  assert.equal(await source.open(feed, new AbortController().signal).position(date), null);
});

test('an absent configuration still opens the public archive', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(null, {status: 404}));
  assert.deepEqual([...(await loadArchives(base)).keys()], [DEFAULT_ARCHIVE_ID]);
});
