import {test} from 'node:test';
import assert from 'node:assert/strict';
import {datesWhere, dayOf, inFlight, isPending, markSaved, queueDays, reduceDays, releaseDays, runLabel, settleDays, statusLabel} from '../src/lib/days.ts';

const A = 20261104, B = 20261105, C = 20261106, D = 20261107;
const stage = fields => ({event: 'stage', message: 'x', ...fields});
const statuses = days => Object.fromEntries(Object.entries(days).map(([date, record]) => [date, record.status]));

test('a day nobody has mentioned is idle, unsaved and pending', () => {
  const day = dayOf({}, A);
  assert.deepEqual(day, {status: 'idle', saved: false, partial: false, fromDevice: false, reason: null});
  assert.equal(isPending(day), true);
  assert.equal(inFlight(day), false);
});

test('the device listing is the truth about what is saved, and blank records are dropped', () => {
  let days = markSaved({}, [A, B]);
  assert.deepEqual(datesWhere(days, d => d.saved), [A, B]);
  days = markSaved(days, [B]);
  assert.deepEqual(Object.keys(days).map(Number), [B]);
});

test('a saved day that is not loaded is still pending', () => {
  assert.equal(isPending(dayOf(markSaved({}, [A]), A)), true);
});

test('a day goes queued, reading, analyzing, loaded in order', () => {
  const scope = [A, B];
  let days = queueDays({}, scope);
  assert.deepEqual(statuses(days), {[A]: 'queued', [B]: 'queued'});
  days = reduceDays(days, stage({phase: 'read'}), scope);
  assert.deepEqual(statuses(days), {[A]: 'reading', [B]: 'queued'});
  days = reduceDays(days, stage({phase: 'analyze', date: A}), scope);
  assert.equal(days[A].status, 'analyzing');
  days = reduceDays(days, {event: 'day', date: A, cached: false, saved: true, partial: false}, scope);
  assert.deepEqual(days[A], {status: 'loaded', saved: true, partial: false, fromDevice: false, reason: null});
  days = reduceDays(days, stage({phase: 'read'}), scope);
  assert.equal(days[B].status, 'reading');
});

test('repeated read stages do not make new objects, so nothing redraws for them', () => {
  const scope = [A];
  const days = reduceDays(queueDays({}, scope), stage({phase: 'read'}), scope);
  assert.equal(reduceDays(days, stage({phase: 'read'}), scope), days);
  assert.equal(reduceDays(days, {event: 'read', record: {}}, scope), days);
});

test('a day restored from this device is loaded, saved and says where it came from', () => {
  const days = reduceDays(queueDays({}, [A]), {event: 'day', date: A, cached: true, saved: true, partial: false}, [A]);
  assert.equal(days[A].fromDevice, true);
  assert.equal(runLabel(days[A]), 'from this device');
});

test('a partial day is loaded but not saved, and says so', () => {
  const days = reduceDays(queueDays({}, [A]), {event: 'day', date: A, cached: false, saved: false, partial: true}, [A]);
  assert.equal(days[A].status, 'loaded');
  assert.equal(days[A].saved, false);
  assert.equal(statusLabel(days[A]), 'partly in the archive');
  assert.equal(isPending(days[A]), false);
});

test('an older worker event without saved or partial is read as before', () => {
  const days = reduceDays({}, {event: 'day', date: A, cached: true}, [A]);
  assert.equal(days[A].saved, true);
  assert.equal(days[A].partial, false);
});

test('a day with no data keeps its reason, is not pending, and can be asked for again', () => {
  let days = reduceDays(queueDays({}, [A]), {event: 'unavailable', date: A, reason: 'Nothing for this day.'}, [A]);
  assert.equal(days[A].status, 'no_data');
  assert.equal(days[A].reason, 'Nothing for this day.');
  assert.equal(isPending(days[A]), false);
  days = queueDays(days, [A]);
  assert.equal(days[A].status, 'queued');
  assert.equal(days[A].reason, null);
});

test('queueing leaves loaded days and days already in flight alone', () => {
  let days = reduceDays({}, {event: 'day', date: A, cached: false, saved: true, partial: false}, [A]);
  days = reduceDays(queueDays(days, [B]), stage({phase: 'read'}), [B]);
  const again = queueDays(days, [A, B]);
  assert.equal(again[A].status, 'loaded');
  assert.equal(again[B].status, 'reading');
});

test('a day queued for the next run is never taken for the one being read', () => {
  const scope = [B];
  let days = queueDays(markSaved({}, [A]), scope);
  days = queueDays(days, [A]); // selected while the run for B is going
  days = reduceDays(days, stage({phase: 'read'}), scope);
  assert.equal(days[A].status, 'queued');
  assert.equal(days[B].status, 'reading');
  days = reduceDays(days, stage({phase: 'analyze', date: A}), scope);
  assert.equal(days[A].status, 'queued');
});

test('however a run ends, the next run\'s days stay in line', () => {
  for (const outcome of [{kind: 'stopped'}, {kind: 'failed', reason: 'x'}]) {
    const waiting = settleDays(queueDays(queueDays(markSaved({}, [A]), [B]), [A]), outcome, [B]);
    assert.equal(waiting[A].status, 'queued', outcome.kind);
  }
  let days = queueDays(queueDays(markSaved({}, [A]), [B]), [A]);
  days = reduceDays(days, {event: 'day', date: B, cached: false, saved: true, partial: false}, [B]);
  days = settleDays(days, {kind: 'finished'}, [B]);
  assert.equal(days[A].status, 'queued');
  assert.equal(days[B].status, 'loaded');
});

test('a failed run marks what it left unfinished, with the reason, and keeps what it finished', () => {
  const scope = [A, B, C];
  let days = queueDays(markSaved({}, [D]), scope);
  days = queueDays(days, [D]);
  days = reduceDays(days, {event: 'day', date: A, cached: false, saved: true, partial: false}, scope);
  days = reduceDays(days, stage({phase: 'read'}), scope);
  days = settleDays(days, {kind: 'failed', reason: 'The connection dropped.'}, scope);
  // D is saved here and waits for the next run, which needs nothing from the archive.
  assert.deepEqual(statuses(days), {[A]: 'loaded', [B]: 'failed', [C]: 'failed', [D]: 'queued'});
  assert.equal(days[B].reason, 'The connection dropped.');
  assert.equal(days[D].saved, true);
  assert.equal(isPending(days[B]), true);
});

test('a stopped run puts unfinished days back to idle, with nothing left in flight', () => {
  const scope = [A, B];
  let days = reduceDays(queueDays({}, scope), stage({phase: 'read'}), scope);
  days = settleDays(days, {kind: 'stopped'}, scope);
  assert.deepEqual(datesWhere(days, inFlight), []);
  assert.deepEqual(days, {});
});

test('whatever happens, settling leaves no day of the run in flight', () => {
  const scope = [A, B, C];
  const events = [stage({phase: 'read'}), stage({phase: 'analyze', date: A}), {event: 'day', date: A, cached: false, saved: true, partial: false},
    stage({phase: 'read'}), {event: 'unavailable', date: B, reason: 'none'}, stage({phase: 'read'}), stage({phase: 'analyze', date: C})];
  for (let cut = 0; cut <= events.length; cut += 1) {
    for (const outcome of [{kind: 'finished'}, {kind: 'stopped'}, {kind: 'failed', reason: 'x'}]) {
      let days = queueDays({}, scope);
      for (const event of events.slice(0, cut)) days = reduceDays(days, event, scope);
      days = settleDays(days, outcome, scope);
      assert.deepEqual(scope.filter(date => inFlight(dayOf(days, date))), [], `cut ${cut}, ${outcome.kind}`);
    }
  }
});

test('a failed day can be queued again and loses its reason', () => {
  let days = settleDays(queueDays({}, [A]), {kind: 'failed', reason: 'x'}, [A]);
  days = queueDays(days, [A]);
  assert.deepEqual(days[A], {status: 'queued', saved: false, partial: false, fromDevice: false, reason: null});
});

test('releasing takes only waiting days out of line', () => {
  let days = queueDays(markSaved({}, [A]), [A, B]);
  days = reduceDays(days, stage({phase: 'read'}), [B]);
  days = releaseDays(days, [A, B]);
  assert.equal(days[A].status, 'idle');
  assert.equal(days[B].status, 'reading');
});

test('labels say something only when there is something to say', () => {
  assert.equal(statusLabel(dayOf({}, A)), null);
  assert.equal(statusLabel({...dayOf({}, A), status: 'loaded'}), null);
  assert.equal(statusLabel({...dayOf({}, A), status: 'queued'}), 'waiting');
  assert.equal(runLabel({...dayOf({}, A), status: 'loaded'}), 'done');
  assert.equal(runLabel({...dayOf({}, A), status: 'loaded', partial: true}), 'done, partly in the archive');
  assert.equal(runLabel({...dayOf({}, A), status: 'no_data'}), 'no data');
});
