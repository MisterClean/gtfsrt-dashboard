// One report fetched for a view: what it is for, the answer, and what went wrong.
// Every view that asks the engine for its own report goes through this, so they all
// behave the same way. Two rules: an answer is only ever shown for the subject it was
// asked about, and a failed refresh removes the old answer rather than leaving numbers
// from an earlier selection on screen as if they were current.

export type ResourceStatus = 'empty' | 'loading' | 'ready' | 'refreshing' | 'failed';

export interface ResourceState<T> {
  /** What the value is about, such as a route ID. A new subject starts from nothing. */
  key: string | null;
  value: T | null;
  failure: string | null;
  pending: boolean;
}

export function emptyResource<T>(): ResourceState<T> {
  return {key: null, value: null, failure: null, pending: false};
}

export function beginLoad<T>(state: ResourceState<T>, key: string): ResourceState<T> {
  if (key !== state.key) return {key, value: null, failure: null, pending: true};
  return {...state, pending: true};
}

export function loadSucceeded<T>(state: ResourceState<T>, value: T): ResourceState<T> {
  return {key: state.key, value, failure: null, pending: false};
}

export function loadFailed<T>(state: ResourceState<T>, failure: string): ResourceState<T> {
  return {key: state.key, value: null, failure, pending: false};
}

export function statusOf<T>(state: ResourceState<T>): ResourceStatus {
  if (state.pending) return state.value === null ? 'loading' : 'refreshing';
  if (state.failure !== null) return 'failed';
  return state.value === null ? 'empty' : 'ready';
}
