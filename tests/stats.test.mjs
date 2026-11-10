import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_EVENTS, SOLID_EVENTS, coverageNote, coverageOf, headlineHours, isShown, isSolid,
  sampleState, sampleText, scheduleSuppressed, share, wilson,
} from '../src/lib/stats.ts';

const day = (over = {}) => ({trips_scheduled: 500, on_time: {total: 900, early: 0, on_time: 700, late: 200}, trip_match: 0.97, warnings: [], ...over});
const gps = () => day({trips_scheduled: 0, on_time: {total: 0, early: 0, on_time: 0, late: 0}, trip_match: null, warnings: ['this day could not be joined to a schedule']});
const matched = pct => day({trip_match: pct / 100});

test('sample thresholds sit at their boundaries', () => {
  assert.equal(sampleState(MIN_EVENTS - 1), 'withheld');
  assert.equal(sampleState(MIN_EVENTS), 'low');
  assert.equal(sampleState(SOLID_EVENTS - 1), 'low');
  assert.equal(sampleState(SOLID_EVENTS), 'ok');
  assert.equal(sampleState(null), 'withheld');
  assert.equal(sampleState(Number.NaN), 'withheld');
  assert.ok(isShown(MIN_EVENTS) && !isShown(0));
  assert.ok(isSolid(SOLID_EVENTS) && !isSolid(SOLID_EVENTS - 1));
});

test('shares below the minimum are withheld instead of shown', () => {
  assert.equal(share(5, 10), null);
  assert.equal(share(15, 20), 0.75);
  assert.match(sampleText(12), /too few trips \(n = 12\)/);
  assert.equal(sampleText(1204), 'n = 1,204');
  assert.match(sampleText(60), /low sample/);
});

test('wilson interval brackets the estimate and stays inside 0 to 1', () => {
  const [lo, hi] = wilson(73, 100);
  assert.ok(lo < 0.73 && hi > 0.73);
  assert.ok(Math.abs(lo - 0.6357) < 0.002 && Math.abs(hi - 0.8073) < 0.002);
  const [zlo, zhi] = wilson(0, 20);
  assert.equal(zlo, 0);
  assert.ok(zhi > 0 && zhi < 0.2);
  assert.deepEqual(wilson(5, 0), null);
  assert.deepEqual(wilson(6, 5), null);
});

test('coverage reads the numeric match rate and ignores note text', () => {
  const worded = day({trip_match: null, warnings: ['Fri, Nov 6: 12% of realtime trip IDs match the schedule, and the rest are left out.']});
  assert.equal(coverageOf({days: [worded]}).matchRate, null);
  assert.equal(coverageOf({days: [matched(39), matched(60), day({trip_match: null})]}).matchRate, 0.39);
});

test('coverage: full, partial, suppressed and GPS-only days', () => {
  assert.equal(coverageOf({days: [day(), day()]}).mode, 'full');
  assert.equal(coverageOf(null).mode, 'full');

  const sound = coverageOf({days: [matched(39)]});
  assert.equal(sound.mode, 'partial');
  assert.equal(sound.matchRate, 0.39);
  assert.match(coverageNote(sound), /39%/);
  assert.ok(!scheduleSuppressed(sound));

  const thin = coverageOf({days: [matched(12)]});
  assert.equal(thin.mode, 'suppressed');
  assert.ok(scheduleSuppressed(thin));
  assert.match(coverageNote(thin), /withheld/);

  assert.equal(coverageOf({days: [matched(25)]}).mode, 'partial');
  assert.equal(coverageOf({days: [matched(24)]}).mode, 'suppressed');
  assert.equal(coverageOf({days: [matched(79)]}).mode, 'partial');
  assert.equal(coverageOf({days: [matched(80)]}).mode, 'full');

  const speedsOnly = coverageOf({days: [gps(), gps()]});
  assert.equal(speedsOnly.mode, 'gps');
  assert.ok(scheduleSuppressed(speedsOnly));

  const mixed = coverageOf({days: [day(), gps()]});
  assert.equal(mixed.mode, 'partial');
  assert.equal(mixed.gpsDays, 1);
});

test('the worst-hour pool excludes thin overnight service', () => {
  const hours = [
    {hour: 3, service: 0.4, n: 25},
    {hour: 8, service: 12, n: 900},
    {hour: 9, service: 10, n: 800},
    {hour: 12, service: 9, n: 700},
    {hour: 23, service: 8, n: 5},
  ];
  const kept = headlineHours(hours, h => h.service, h => h.n).map(h => h.hour);
  assert.deepEqual(kept, [8, 9, 12]);
  assert.deepEqual(headlineHours([], h => h, h => h), []);
});
