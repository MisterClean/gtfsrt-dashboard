import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ARCHIVE, MAX_OBJECT_BYTES, enforceObjectSize, validateArchiveURL} from '../src/engine/contracts.js';
import {securityHeaders} from '../scripts/security.mjs';
import {csvCell} from '../src/lib/download.ts';
import {decodeDates, encodeDates, lastDays, rangeDates} from '../src/lib/dates.ts';
import {datesLabel, deviation, hourLabel, routeName, signedPct, speed} from '../src/lib/format.ts';
import {niceRange, ticks} from '../src/lib/scale.ts';

const object = `${ARCHIVE}vehicle_positions/date=2026-11-05/base64url=cHVibGlj/data.parquet`;

test('rejects other buckets, credentialed URLs, query strings, and encoded path escapes', () => {
  assert.equal(validateArchiveURL(object), object);
  for (const url of [
    'https://storage.googleapis.com/another-bucket/data.parquet',
    'https://storage.googleapis.com/parquet.gtfsrt.io.evil/data.parquet',
    'https://storage.googleapis.com.evil.test/parquet.gtfsrt.io/data.parquet',
    'https://user:password@storage.googleapis.com/parquet.gtfsrt.io/data.parquet',
    `${object}?token=private`, `${object}#fragment`,
    `${ARCHIVE}../another-bucket/data.parquet`, `${ARCHIVE}vehicle_positions/%2fother/data.parquet`,
    'http://storage.googleapis.com/parquet.gtfsrt.io/data.parquet',
  ]) assert.throws(() => validateArchiveURL(url), undefined, url);
});

test('refuses objects with an unknown size or beyond the per-object limit', () => {
  assert.equal(enforceObjectSize(1000, 'x'), 1000);
  assert.throws(() => enforceObjectSize(0, 'x'), /unavailable/);
  assert.throws(() => enforceObjectSize(Number.NaN, 'x'), /unavailable/);
  assert.throws(() => enforceObjectSize(MAX_OBJECT_BYTES + 1, 'x'), /MiB/);
});

test('the response policy limits networking and allows WASM without JavaScript eval', () => {
  const policy = securityHeaders['Content-Security-Policy'];
  assert.match(policy, /connect-src 'self' https:\/\/storage\.googleapis\.com\/parquet\.gtfsrt\.io\/ https:\/\/tiles\.openfreemap\.org/);
  assert.match(policy, /worker-src 'self'/);
  assert.match(policy, /'wasm-unsafe-eval'/);
  assert.match(policy, /style-src 'self';/);
  assert.ok(!policy.includes("'unsafe-eval'"));
  assert.equal(securityHeaders['Referrer-Policy'], 'no-referrer');
});

test('the most recent days stop short of the newest file, which lacks a full evening', () => {
  assert.deepEqual(lastDays('2026-01-01', '2026-11-06', 'weekday', 2), [20261104, 20261105]);
  // Saturday the 7th is the newest file, so Friday the 6th is the last complete weekday.
  assert.deepEqual(lastDays('2026-01-01', '2026-11-07', 'weekday', 1), [20261106]);
  assert.deepEqual(lastDays('2026-01-01', '2026-11-08', 'saturday', 1), [20261107]);
  assert.deepEqual(lastDays('2026-11-05', '2026-11-06', 'weekday', 5), [20261105]);
});

test('dates survive the URL in their most compact form', () => {
  const roundTrip = dates => decodeDates(new URLSearchParams(encodeDates(dates)));
  const week = rangeDates('2026-11-02', '2026-11-06');
  assert.deepEqual(encodeDates(week), {from: '2026-11-02', to: '2026-11-06'});
  assert.deepEqual(roundTrip(week), week);
  const weekdays = rangeDates('2026-11-02', '2026-11-13', new Set([1, 2, 3, 4, 5]));
  assert.equal(encodeDates(weekdays).days, 'wk');
  assert.deepEqual(roundTrip(weekdays), weekdays);
  assert.deepEqual(roundTrip([20261102, 20261105]), [20261102, 20261105]);
});

test('shared links with malformed dates are ignored rather than misread', () => {
  for (const search of ['from=2026-1-1&to=2026-1-2', 'from=2026-11-05&to=2026-11-01', 'from=x&to=y', 'dates=abc', '']) {
    assert.deepEqual(decodeDates(new URLSearchParams(search)), [], search);
  }
  assert.ok(decodeDates(new URLSearchParams('from=2000-01-01&to=2030-01-01')).length <= 62);
});

test('CSV cells are quoted and cannot run as spreadsheet formulas', () => {
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(csvCell('-1+2'), "'-1+2");
  assert.equal(csvCell(12.5), '12.5');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(Number.NaN), '');
});

test('formatting handles overnight hours, signs and missing values', () => {
  assert.equal(hourLabel(25), '1 AM');
  assert.equal(hourLabel(12), 'noon');
  assert.equal(hourLabel(24), 'midnight');
  assert.equal(deviation(-45), '−0:45');
  assert.equal(deviation(150), '+2:30');
  assert.equal(signedPct(-0.123), '−12%');
  assert.equal(signedPct(0.1), '+10%');
  assert.equal(speed(null, 'imperial'), '—');
  assert.equal(speed(10, 'imperial'), '22.4');
  assert.equal(speed(10, 'metric'), '36.0');
  assert.equal(datesLabel([20261102, 20261106]), 'Nov 2–6, 2026');
  assert.equal(datesLabel([20261030, 20261102]), 'Oct 30–Nov 2, 2026');
});

test('route names that only repeat the number are dropped', () => {
  assert.equal(routeName('80', 'Route 80'), '');
  assert.equal(routeName('80', '80'), '');
  assert.equal(routeName('A', 'Downtown Loop'), 'Downtown Loop');
  assert.equal(routeName('80', ''), '');
});

test('axis ticks are round and cover the range', () => {
  assert.deepEqual(ticks(0, 100, 4), [0, 25, 50, 75, 100]);
  assert.deepEqual(niceRange(13.2, 19.7, 3), [12.5, 20]);
  assert.deepEqual(niceRange(5, 5), [4, 6]);
});
