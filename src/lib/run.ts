// One analysis run, as one value. A run is idle, running, stopped or failed, and what
// the page says about it (progress, a stall, which days a failure left unfinished) lives
// inside the phase it belongs to, so nothing from a finished run can linger. Pure, so it
// can be tested without a browser.
import {classifyError, type EngineError} from '../engine/errors.ts';
import {reduceProgress, startProgress, type Progress, type ProgressEvent} from './progress.ts';

export type RunState =
  | {phase: 'idle'}
  | {phase: 'running'; id: number; dates: number[]; progress: Progress; stalled: boolean; lastSign: number}
  /** The visitor stopped it. `left` are the days it had not finished. */
  | {phase: 'stopped'; finished: number; left: number[]}
  /** It failed. `left` are the days it had not finished, which a retry asks for again. */
  | {phase: 'failed'; failure: EngineError; finished: number; left: number[]};

export const IDLE: RunState = Object.freeze({phase: 'idle'});

/** With streaming reads, this long without a sign of progress means something is stuck. */
export const STALL_MS = 120_000;

export function startRun(id: number, dates: readonly number[], now = Date.now()): RunState {
  return {phase: 'running', id, dates: [...dates], progress: startProgress([...dates], now), stalled: false, lastSign: now};
}

/** Any event from the worker is a sign of life. */
export function runEvent(state: RunState, event: ProgressEvent, now = Date.now()): RunState {
  if (state.phase !== 'running') return state;
  return {...state, progress: reduceProgress(state.progress, event), stalled: false, lastSign: now};
}

/** Called on a timer while a run is going. */
export function checkStall(state: RunState, now = Date.now()): RunState {
  if (state.phase !== 'running') return state;
  const stalled = now - state.lastSign > STALL_MS;
  return stalled === state.stalled ? state : {...state, stalled};
}

/** The run returned. `left` are the days it was asked for and did not finish. */
export function endRun(state: RunState, stopped: boolean, left: readonly number[]): RunState {
  if (state.phase !== 'running') return state;
  if (!stopped || !left.length) return IDLE;
  return {phase: 'stopped', finished: state.dates.length - left.length, left: [...left]};
}

/** The run threw. A stop is the visitor's own doing, not a failure. */
export function failRun(state: RunState, error: unknown, left: readonly number[]): RunState {
  if (state.phase !== 'running') return state;
  const failure = classifyError(error);
  if (failure.kind === 'cancelled') return endRun(state, true, left);
  return {phase: 'failed', failure, finished: state.dates.length - left.length, left: [...left]};
}

/**
 * The selection changed. A notice about days that are no longer selected has nothing
 * left to say, and its retry would act on different days than the ones it names.
 */
export function selectionChanged(state: RunState, selected: readonly number[]): RunState {
  if (state.phase !== 'stopped' && state.phase !== 'failed') return state;
  const left = state.left.filter(date => selected.includes(date));
  if (!left.length) return IDLE;
  return left.length === state.left.length ? state : {...state, left};
}
