import {test} from 'node:test';
import assert from 'node:assert/strict';
import {IDLE, STALL_MS, checkStall, endRun, failRun, runEvent, selectionChanged, startRun} from '../src/lib/run.ts';
import {EngineError} from '../src/engine/errors.ts';
import {BOOT_MESSAGE, bootFailed, bootWords, isBooting} from '../src/lib/startup.ts';

const A = 20261104, B = 20261105, C = 20261106;
const stage = fields => ({event: 'stage', message: 'x', ...fields});

test('a run starts with its days, a fresh bar and no stall', () => {
  const run = startRun(7, [A, B], 1000);
  assert.equal(run.phase, 'running');
  assert.equal(run.id, 7);
  assert.deepEqual(run.dates, [A, B]);
  assert.equal(run.progress.fraction, 0);
  assert.equal(run.progress.dayCount, 2);
  assert.equal(run.stalled, false);
});

test('the run does not share its list of days with the caller', () => {
  const dates = [A];
  const run = startRun(1, dates);
  dates.push(B);
  assert.deepEqual(run.dates, [A]);
});

test('progress moves forward with stage events and never back', () => {
  let run = startRun(1, [A], 0);
  run = runEvent(run, stage({fraction: 0.5, message: 'Reading'}), 10);
  run = runEvent(run, stage({fraction: 0.2, message: 'Schedule'}), 20);
  assert.equal(run.progress.fraction, 0.5);
  assert.equal(run.progress.message, 'Schedule');
});

test('a run stalls after long silence, and any event clears it', () => {
  let run = startRun(1, [A], 0);
  assert.equal(checkStall(run, STALL_MS).stalled, false);
  run = checkStall(run, STALL_MS + 1);
  assert.equal(run.stalled, true);
  assert.equal(checkStall(run, STALL_MS + 2), run, 'no new object when nothing changed');
  run = runEvent(run, {event: 'read', record: {}}, STALL_MS + 5);
  assert.equal(run.stalled, false);
  assert.equal(checkStall(run, STALL_MS + 6).stalled, false);
});

test('events, stall checks and endings mean nothing when no run is going', () => {
  for (const state of [IDLE, {phase: 'stopped', finished: 0, left: [A]}]) {
    assert.equal(runEvent(state, stage({fraction: 1})), state);
    assert.equal(checkStall(state, 1e12), state);
    assert.equal(endRun(state, true, [A]), state);
    assert.equal(failRun(state, new Error('x'), [A]), state);
  }
});

test('a run that finishes goes back to idle and leaves nothing behind', () => {
  assert.equal(endRun(startRun(1, [A, B]), false, []), IDLE);
  // Days it could not get, such as ones with no data, are not "left" and need no notice.
  assert.equal(endRun(startRun(1, [A, B]), false, [B]), IDLE);
});

test('a stopped run says how many days finished and which are left', () => {
  assert.deepEqual(endRun(startRun(1, [A, B, C]), true, [B, C]), {phase: 'stopped', finished: 1, left: [B, C]});
});

test('a stop that arrives after everything finished is just a finished run', () => {
  assert.equal(endRun(startRun(1, [A]), true, []), IDLE);
});

test('a failure keeps the classified error and the days it left', () => {
  const run = failRun(startRun(1, [A, B]), new TypeError('Failed to fetch'), [B]);
  assert.equal(run.phase, 'failed');
  assert.equal(run.failure.kind, 'offline');
  assert.equal(run.finished, 1);
  assert.deepEqual(run.left, [B]);
});

test('a cancelled error is a stop, not a failure', () => {
  const run = failRun(startRun(1, [A, B]), new EngineError('cancelled', 'The analysis was stopped.'), [A, B]);
  assert.deepEqual(run, {phase: 'stopped', finished: 0, left: [A, B]});
});

test('a notice follows the selection: it narrows, and goes when none of its days are selected', () => {
  const failed = failRun(startRun(1, [A, B]), new Error('HTTP 503'), [A, B]);
  assert.equal(selectionChanged(failed, [A, B, C]), failed);
  assert.deepEqual(selectionChanged(failed, [B, C]).left, [B]);
  assert.equal(selectionChanged(failed, [B, C]).phase, 'failed');
  assert.equal(selectionChanged(failed, [C]), IDLE);
  const stopped = endRun(startRun(1, [A]), true, [A]);
  assert.equal(selectionChanged(stopped, []), IDLE);
});

test('changing the selection does nothing to a run that is going', () => {
  const run = startRun(1, [A]);
  assert.equal(selectionChanged(run, []), run);
  assert.equal(selectionChanged(IDLE, [A]), IDLE);
});

test('a startup failure remembers its step and blames the right thing', () => {
  const engine = bootFailed('engine', new Error('This browser needs WebAssembly.'));
  assert.equal(engine.step, 'failed');
  assert.equal(engine.at, 'engine');
  assert.equal(engine.failure.kind, 'unsupported');
  assert.equal(engine.failure.context, 'starting the analysis engine');
  assert.equal(bootWords(engine).title, "This browser can't run the analysis engine.");
  const catalog = bootFailed('catalog', new TypeError('Failed to fetch'));
  assert.equal(catalog.failure.context, 'loading the archive catalog');
  assert.match(bootWords(catalog).advice, /agency list comes from the archive/);
});

test('an engine file that will not load is not blamed on the archive, and can be retried', () => {
  const words = bootWords(bootFailed('engine', new TypeError('Failed to fetch')));
  assert.equal(words.title, 'The analysis engine could not start.');
  assert.doesNotMatch(`${words.title} ${words.advice}`, /archive|agency list|days already finished/i);
  assert.equal(words.retryable, true);
});

test('every startup step has its own words, and only the steps count as booting', () => {
  assert.equal(new Set(Object.values(BOOT_MESSAGE)).size, 3);
  for (const step of ['engine', 'catalog', 'opening']) assert.equal(isBooting({step}), true);
  assert.equal(isBooting({step: 'ready'}), false);
  assert.equal(isBooting(bootFailed('engine', new Error('x'))), false);
});

test('a startup failure the worker already labelled is relabelled with the step, and keeps the rest', () => {
  const fromWorker = new EngineError('http', 'The archive returned HTTP 503.', {status: 503, context: 'calling catalog', detail: 'stack'});
  const boot = bootFailed('catalog', fromWorker);
  assert.equal(boot.failure.context, 'loading the archive catalog');
  assert.equal(boot.failure.kind, 'http');
  assert.equal(boot.failure.status, 503);
  assert.equal(boot.failure.detail, 'stack');
});
