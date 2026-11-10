import {test} from 'node:test';
import assert from 'node:assert/strict';
import {matchFromLegacyNotes, withTripMatch} from '../src/engine/tripmatch.ts';
import {EngineError, classifyError, isTransient} from '../src/engine/errors.ts';
import {isIndeterminate, sizeReport} from '../src/lib/progress.ts';

test('trip_match comes from the stored number, and from old notes only when none was stored', () => {
  const overview = {days: [
    {date: '2026-11-05', warnings: []},
    {date: '2026-11-06', warnings: ['x']},
    {date: '2026-11-07', warnings: ['2026-11-07: 39% of realtime trip IDs match the schedule, and the rest are left out.']},
    {date: '2026-11-08', warnings: []},
  ]};
  const out = withTripMatch(overview, new Map([[20261105, 0.97], [20261106, null]]));
  assert.deepEqual(out.days.map(d => d.trip_match), [0.97, null, 0.39, null]);
  assert.equal(matchFromLegacyNotes(['nothing here']), null);
});

test('connection trouble is transient, data trouble is not', () => {
  assert.ok(isTransient(classifyError(new TypeError('Failed to fetch'))));
  assert.ok(isTransient(classifyError(new Error('Schedule table stops returned HTTP 503. This is an access'))));
  assert.ok(isTransient(classifyError(Object.assign(new Error('signal timed out'), {name: 'TimeoutError'}))));
  assert.ok(!isTransient(classifyError(new Error('Schedule table stops returned HTTP 404.'))));
  assert.ok(!isTransient(classifyError(new Error('Schedule table stops is larger than this app reads.'))));
  assert.ok(!isTransient(new EngineError('schedule', 'bad')));
});

test('size report: the estimate until files are sized, never "0 KB" before bytes arrive', () => {
  assert.deepEqual(sizeReport({bytesDone: null, bytesTotal: null}, 48e6), {total: 48e6, exact: false, done: null});
  assert.deepEqual(sizeReport({bytesDone: 0, bytesTotal: 75e6}, 48e6), {total: 75e6, exact: true, done: null});
  assert.equal(sizeReport({bytesDone: 90e6, bytesTotal: 75e6}, 48e6).done, 75e6);
  assert.equal(isIndeterminate({fraction: 0}), true);
  assert.equal(isIndeterminate({fraction: 0.02}), false);
});
