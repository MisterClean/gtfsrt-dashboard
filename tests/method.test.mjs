import {test} from 'node:test';
import assert from 'node:assert/strict';
import {METHOD_LABEL, METHOD_NOTE, chooseMethod, usesSchedule, withMethod} from '../src/engine/method.ts';

const base = {hasSchedule: true, publishedBefore: true, scheduleFailed: false, hasFixes: true, match: 0.95, minMatch: 0.1};

test('a covering schedule that matches is used', () => {
  assert.equal(chooseMethod(base), 'schedule');
});

test('a schedule the archive only captured later is used and named as such', () => {
  assert.equal(chooseMethod({...base, publishedBefore: false}), 'schedule_later');
});

test('no covering schedule means GPS only', () => {
  assert.equal(chooseMethod({...base, hasSchedule: false}), 'gps_no_schedule');
  // Nothing else matters once there is no schedule.
  assert.equal(chooseMethod({...base, hasSchedule: false, scheduleFailed: true, match: 0}), 'gps_no_schedule');
});

test('an unreadable schedule means GPS only, whatever the match would have been', () => {
  assert.equal(chooseMethod({...base, scheduleFailed: true}), 'gps_schedule_unreadable');
});

test('the match threshold is inclusive, as it was', () => {
  assert.equal(chooseMethod({...base, match: 0.1}), 'schedule');
  assert.equal(chooseMethod({...base, match: 0.0999}), 'gps_low_match');
});

test('a day with no positions keeps its schedule: there is nothing to mismatch', () => {
  assert.equal(chooseMethod({...base, hasFixes: false, match: 0}), 'schedule');
});

test('agrees with the rule the worker used before, for every combination', () => {
  for (const hasSchedule of [true, false]) for (const scheduleFailed of [true, false]) for (const hasFixes of [true, false]) for (const match of [0, 0.05, 0.1, 0.5, 1]) {
    const joined = hasSchedule && !scheduleFailed;
    const before = joined && (!hasFixes || match >= 0.1);
    const method = chooseMethod({hasSchedule, scheduleFailed, hasFixes, match, minMatch: 0.1, publishedBefore: true});
    assert.equal(usesSchedule(method), before, JSON.stringify({hasSchedule, scheduleFailed, hasFixes, match}));
  }
});

test('every method has a label and an explanation', () => {
  for (const method of ['schedule', 'schedule_later', 'gps_no_schedule', 'gps_schedule_unreadable', 'gps_low_match']) {
    assert.ok(METHOD_LABEL[method]);
    assert.ok(METHOD_NOTE[method].endsWith('.'));
  }
});

test('reports get each day\'s method, and null for days saved before it was kept', () => {
  const report = withMethod({days: [{date: '2026-11-04'}, {date: '2026-11-05'}]}, new Map([[20261104, 'gps_low_match']]));
  assert.deepEqual(report.days.map(day => day.method), ['gps_low_match', null]);
});
