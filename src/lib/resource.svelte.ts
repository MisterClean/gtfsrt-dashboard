// The reactive wrapper around resource.ts, for a view that asks the engine for its own
// report. Call it while the component is being set up.
import {untrack} from 'svelte';
import {beginLoad, emptyResource, loadFailed, loadSucceeded, statusOf, type ResourceState, type ResourceStatus} from './resource.ts';
import {errorText} from './state.svelte';

export interface Resource<T> {
  readonly value: T | null;
  readonly failure: string | null;
  readonly status: ResourceStatus;
  /** An answer is on its way, whether or not an older one is showing. */
  readonly pending: boolean;
}

/**
 * `source` names what to load and how, or returns null when there is nothing to ask
 * yet. It runs inside an effect, so whatever reactive state it reads (the results
 * version, a route ID, a filter) decides when the report is asked for again. An answer
 * that arrives after a newer request has started is dropped.
 */
export function resource<T>(source: () => {key: string; load: () => Promise<T>} | null): Resource<T> {
  // Raw: reports can be megabytes of geometry, and nothing mutates them.
  let state = $state.raw<ResourceState<T>>(emptyResource());
  let request = 0;

  $effect(() => {
    const wanted = source();
    const current = ++request;
    if (!wanted) {
      state = emptyResource();
      return;
    }
    state = beginLoad(untrack(() => state), wanted.key);
    untrack(() => wanted.load()).then(
      value => {
        if (current === request) state = loadSucceeded(state, value);
      },
      error => {
        if (current === request) state = loadFailed(state, errorText(error));
      },
    );
  });

  return {
    get value() { return state.value; },
    get failure() { return state.failure; },
    get status() { return statusOf(state); },
    get pending() { return state.pending; },
  };
}
