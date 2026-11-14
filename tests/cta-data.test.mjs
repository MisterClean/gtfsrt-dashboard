import assert from 'node:assert/strict';
import {test} from 'node:test';
import {gapsOnDate, localMidnight, weekdaysBefore} from '../scripts/cta-source.mjs';

test('the snapshot keeps exactly the 20 elapsed weekdays through Nov. 9', () => {
  const dates = weekdaysBefore('2026-11-10', 20);
  assert.deepEqual(dates, [
    '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16',
    '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23',
    '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30',
    '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-09',
  ]);
});

test('archive gaps are bus-specific and intersect Chicago calendar days', () => {
  const night = {
    start: '2026-10-13T14:30-05:00', end: '2026-10-14T00:00-05:00',
    feeds: ['bus'], note: 'Quota reached',
  };
  const rail = {...night, feeds: ['train']};
  assert.deepEqual(gapsOnDate([night, rail], '2026-10-13'), [
    {start: night.start, end: night.end, note: night.note},
  ]);
  assert.deepEqual(gapsOnDate([night, rail], '2026-10-14'), []);
});

test('Chicago fall-back makes the Nov. 1 archive partition 25 hours long', () => {
  const fallBack = localMidnight('2026-11-01');
  const following = localMidnight('2026-11-02');
  assert.equal(fallBack.utcOffsetSeconds, -5 * 3600);
  assert.equal(following.utcOffsetSeconds, -6 * 3600);
  assert.equal(following.midnightMs - fallBack.midnightMs, 25 * 3600 * 1000);
});
