import {test} from 'node:test';
import assert from 'node:assert/strict';
import {durationLabel, estimateLoad, formatElapsed, reduceProgress, startProgress} from '../src/lib/progress.ts';

const dates = [20261104, 20261105, 20261106];
const stage = (fields) => ({event: 'stage', message: 'x', ...fields});

test('starts at zero with the number of days', () => {
  const progress = startProgress(dates, 1000);
  assert.equal(progress.fraction, 0);
  assert.equal(progress.dayCount, 3);
});

test('the fraction never moves backwards, even when a stage reports zero', () => {
  let progress = startProgress(dates);
  const seen = [];
  for (const fraction of [0.1, 0.4, 0, 0.35, undefined, 0.6, 0.2, 1.4]) {
    progress = reduceProgress(progress, stage({fraction}));
    seen.push(progress.fraction);
  }
  assert.deepEqual(seen, [0.1, 0.4, 0.4, 0.4, 0.4, 0.6, 0.6, 1]);
});

test('the day counter and byte count only grow, the byte total can be revised', () => {
  let progress = startProgress(dates);
  progress = reduceProgress(progress, stage({dayIndex: 2, dayCount: 3, bytesDone: 500, bytesTotal: 1000}));
  progress = reduceProgress(progress, stage({dayIndex: 0, bytesDone: 100}));
  assert.equal(progress.dayIndex, 2);
  assert.equal(progress.bytesDone, 500);
  progress = reduceProgress(progress, stage({bytesTotal: 1500}));
  assert.equal(progress.bytesTotal, 1500);
  assert.equal(progress.bytesDone, 500);
});

test('a stage without byte or day fields keeps the earlier values (schedule stages)', () => {
  let progress = startProgress(dates);
  progress = reduceProgress(progress, stage({fraction: 0.5, dayIndex: 2, dayCount: 3, bytesDone: 10, bytesTotal: 20, phase: 'read'}));
  progress = reduceProgress(progress, stage({message: 'Reading the schedule', phase: 'schedule'}));
  assert.equal(progress.fraction, 0.5);
  assert.equal(progress.dayIndex, 2);
  assert.equal(progress.dayCount, 3);
  assert.equal(progress.bytesTotal, 20);
  assert.equal(progress.phase, 'schedule');
});

test('unrelated events leave progress alone', () => {
  const progress = startProgress(dates);
  assert.equal(reduceProgress(progress, {event: 'warning', message: 'x'}), progress);
});

test('formats elapsed time', () => {
  assert.equal(formatElapsed(0), '0:00');
  assert.equal(formatElapsed(75_000), '1:15');
  assert.equal(formatElapsed(3_725_000), '1:02:05');
  assert.equal(formatElapsed(-5), '0:00');
});

test('estimates scale with the files a day touches and flag large loads', () => {
  const small = {date_min: '2026-01-01', date_max: '2026-01-10', total_bytes: 100e6};
  const one = estimateLoad(small, [20260105]);
  assert.equal(one.level, 'small');
  assert.equal(Math.round(one.bytes), 20e6); // 10 MB a day, two UTC files
  assert.equal(estimateLoad(small, [20260105, 20260106]).bytes > one.bytes, true);
  assert.deepEqual(estimateLoad(small, []), {bytes: 0, seconds: 0, level: 'small'});

  const nyc = {date_min: '2026-01-01', date_max: '2026-01-10', total_bytes: 3e9};
  assert.equal(estimateLoad(nyc, [20260105]).level, 'large');
  assert.equal(estimateLoad(nyc, [20260105, 20260106, 20260107, 20260108, 20260109]).level, 'huge');
});

test('durations read as seconds then minutes', () => {
  assert.equal(durationLabel(8), 'about 10 seconds');
  assert.equal(durationLabel(80), 'about 80 seconds');
  assert.equal(durationLabel(300), 'about 5 minutes');
});
