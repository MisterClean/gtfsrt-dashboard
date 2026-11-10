import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {classify, findOverride, groupOf, parseHealthFile, resolveHealth, staleness, approxBytesPerDay} from '../src/lib/health.ts';
import {buildHealthFile, headObject} from '../scripts/validate-feeds.mjs';

const feed = (over = {}) => ({
  base64url: 'abc', feed_type: 'vehicle_positions', agency_id: 'a', agency_name: 'A', system_id: null, system_name: null,
  date_min: '2026-01-01', date_max: '2026-11-08', total_records: 1000, total_bytes: 300 * 1024 * 1024, ...over,
});
const REF = '2026-11-08';
const run = (f, extra = {}) => classify({facts: f, reference: REF, ...extra});

test('classifies healthy, empty and stale feeds', () => {
  assert.deepEqual(run(feed()), {status: 'ok', reason: null});
  assert.equal(run(feed({total_records: 0})).status, 'empty');
  assert.equal(run(feed({total_bytes: 0})).status, 'empty');
  const stale = run(feed({date_max: '2026-07-22'}));
  assert.equal(stale.status, 'stale');
  assert.equal(stale.reason, 'Data ends Jul 21');
});

test('stale boundary is 14 days behind the newest archive day', () => {
  assert.equal(run(feed({date_max: '2026-10-24'})).status, 'stale');
  assert.equal(run(feed({date_max: '2026-10-25'})).status, 'ok');
});

test('classifies schedule, match and thin-service problems, worst first', () => {
  assert.equal(run(feed(), {schedule_join: false}).status, 'gps_only');
  assert.equal(run(feed(), {trip_match: 0.39}).reason, 'Only 39% of trip IDs match the schedule');
  assert.equal(run(feed(), {trip_match: 0.5}).status, 'ok');
  assert.equal(run(feed(), {trips_per_day: 176}).status, 'thin');
  assert.equal(run(feed(), {trips_per_day: 500}).status, 'ok');
  assert.equal(run(feed(), {schedule_join: false, trip_match: 0.1, trips_per_day: 5}).status, 'gps_only');
  assert.equal(run(feed({total_records: 0, date_max: '2026-01-02'}), {schedule_join: false}).status, 'empty');
});

test('overrides beat the probe: forced status, reason, hide and note', () => {
  const base = {facts: feed(), reference: REF, checked_at: 'now'};
  const forced = resolveHealth({...base, override: {status: 'gps_only', note: 'n'}});
  assert.equal(forced.status, 'gps_only');
  assert.equal(forced.reason, 'GPS speeds only — no schedule match');
  assert.equal(forced.note, 'n');
  assert.equal(resolveHealth({...base, override: {status: 'gps_only', reason: 'Custom'}}).reason, 'Custom');
  assert.equal(resolveHealth({...base, facts: feed({total_records: 0}), override: {status: 'ok'}}).status, 'ok');
  assert.equal(resolveHealth({...base, facts: feed({total_records: 0})}).hidden, true);
  assert.equal(resolveHealth({...base, facts: feed({total_records: 0}), override: {hide: false}}).hidden, false);
  assert.equal(resolveHealth({...base, override: {hide: true}}).hidden, true);
  assert.equal(resolveHealth({...base, override: {trip_match: 0.39}}).status, 'low_match');
  assert.equal(resolveHealth({...base, measured: {trip_match: 0.9}, override: {trip_match: 0.2}}).status, 'low_match');
  assert.equal(resolveHealth({...base, override: {status: 'ok'}}).reason, null);
});

test('large comes from size unless overridden', () => {
  const base = {reference: REF, checked_at: 'now'};
  const big = feed({total_bytes: 100 * 1024 * 1024 * 312});
  assert.equal(resolveHealth({...base, facts: big}).large, true);
  assert.equal(resolveHealth({...base, facts: feed()}).large, false);
  assert.equal(resolveHealth({...base, facts: feed(), override: {large: true}}).large, true);
  assert.equal(approxBytesPerDay(feed({date_min: '2026-01-01', date_max: '2026-01-10', total_bytes: 1000})), 100);
});

test('the specific override key wins over the agency key', () => {
  const overrides = {septa: {note: 'agency'}, 'septa/rail': {note: 'rail'}};
  assert.equal(findOverride(overrides, {agency_id: 'septa', system_id: 'rail'}).note, 'rail');
  assert.equal(findOverride(overrides, {agency_id: 'septa', system_id: 'bus'}).note, 'agency');
  assert.equal(findOverride(overrides, {agency_id: 'x', system_id: null}), undefined);
});

test('groups statuses for the picker, unknown feeds stay selectable', () => {
  assert.deepEqual(['ok', 'thin', 'gps_only', 'low_match', 'stale', 'empty', null].map(groupOf),
    ['working', 'limited', 'limited', 'limited', 'stale', 'stale', 'unknown']);
});

test('staleness is measured against today, not the archive', () => {
  assert.deepEqual(staleness({date_max: '2026-07-22'}, '2026-11-09'), {stale: true, latest_day: '2026-07-21'});
  assert.equal(staleness({date_max: '2026-11-08'}, '2026-11-09').stale, false);
});

test('parses the health file defensively', () => {
  assert.deepEqual(parseHealthFile(null), {});
  assert.deepEqual(parseHealthFile({schema: 2, feeds: {}}), {});
  assert.deepEqual(parseHealthFile({schema: 1, feeds: {a: {status: 'bogus'}, b: {status: 'ok'}}}), {b: {status: 'ok'}});
});

test('buildHealthFile uses the newest archive day as reference and the probe result', async () => {
  const inventory = [feed({base64url: 'one'}), feed({base64url: 'two', date_max: '2026-07-22'}),
    feed({base64url: 'three', feed_type: 'trip_updates'}), feed({base64url: 'bad id!'})];
  const file = await buildHealthFile({inventory, overrides: {}, checkedAt: 't', probe: async f => ({head_ok: f.base64url !== 'one', bytes: 1234})});
  assert.equal(file.reference_date, REF);
  assert.deepEqual(Object.keys(file.feeds), ['one', 'two']);
  assert.equal(file.feeds.one.status, 'stale');
  assert.equal(file.feeds.one.reason, 'The newest archive file is missing');
  assert.equal(file.feeds.two.status, 'stale');
  assert.equal(file.feeds.two.approx_bytes_per_day, 1234);
  assert.equal(file.checked_at, 't');
  assert.equal(Object.keys(parseHealthFile(file)).length, 2);
});

test('headObject distinguishes missing, failing and unreachable', async () => {
  const f = feed();
  const reply = (status, length) => async () => ({status, ok: status < 300, headers: {get: () => length}});
  assert.deepEqual(await headObject(f, reply(200, '999')), {head_ok: true, bytes: 999});
  assert.deepEqual(await headObject(f, reply(404, null)), {head_ok: false, bytes: null});
  assert.deepEqual(await headObject(f, reply(503, null)), {head_ok: null, bytes: null});
  assert.deepEqual(await headObject(f, async () => { throw new Error('offline'); }), {head_ok: null, bytes: null});
});

test('the committed health file and overrides are valid and consistent', async () => {
  const file = JSON.parse(await readFile(new URL('../public/feed-health.json', import.meta.url), 'utf8'));
  const overrides = JSON.parse(await readFile(new URL('../src/data/feed-overrides.json', import.meta.url), 'utf8'));
  assert.equal(Object.keys(parseHealthFile(file)).length, Object.keys(file.feeds).length);
  for (const key of Object.keys(overrides)) {
    if (key === '_help') continue;
    assert.ok(Object.values(file.feeds).some(h => h.id === key || h.id.startsWith(`${key}/`)), `override ${key} matches no feed`);
  }
  assert.equal(Object.values(file.feeds).find(h => h.id === 'bigbluebus').status, 'gps_only');
});
