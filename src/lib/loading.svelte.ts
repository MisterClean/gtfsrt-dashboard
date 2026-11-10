// What the loading UI shows: progress for the current run, the last failure in its
// categorised form, and a notice when the browser can't keep results. Kept apart from
// the main app state so that file stays small. The app state forwards worker events here.
import {engine} from '../engine/client';
import {classifyError, errorDetails, friendlyError, type EngineError, type FriendlyError} from '../engine/errors';
import type {EngineEvent} from '../engine/types';
import {reduceProgress, startProgress, type DayStatus, type Progress} from './progress';

class LoadingState {
  progress = $state<Progress | null>(null);
  failure = $state<EngineError | null>(null);
  catalogFailure = $state<EngineError | null>(null);
  /** Days that failed in the last run, so the date picker can mark them. */
  failedDates = $state<number[]>([]);
  /** The browser can't keep results. Said once, not per day. */
  cacheNotice = $state<string | null>(null);

  friendly = $derived<FriendlyError | null>(this.failure ? friendlyError(this.failure) : null);
  details = $derived(this.failure ? errorDetails(this.failure) : '');

  constructor() {
    engine.onEvent(event => {
      // Cache trouble can happen outside a run, so it isn't tied to the current one.
      if (event.event === 'cache') this.cacheNotice ??= event.message;
    });
  }

  begin(dates: number[]) {
    this.failure = null;
    this.failedDates = [];
    this.progress = startProgress(dates);
  }

  handle(event: EngineEvent) {
    if (this.progress) this.progress = reduceProgress(this.progress, event);
  }

  end() {
    this.progress = null;
  }

  fail(error: unknown, context?: string) {
    const classified = classifyError(error, context);
    // A stop is the visitor's own doing, not a failure.
    if (classified.kind === 'cancelled') return;
    console.error('[transit-almanac] run failed:', classified.kind, classified.message, classified.cause ?? '');
    this.failure = classified;
    if (this.progress) {
      const pending = Object.entries(this.progress.days).filter(([, s]) => s !== 'done' && s !== 'cached' && s !== 'no_data');
      this.failedDates = pending.map(([date]) => Number(date));
    }
  }

  failCatalog(error: unknown) {
    this.catalogFailure = classifyError(error, 'loading the archive catalog');
    console.error('[transit-almanac] catalog failed:', this.catalogFailure.kind, this.catalogFailure.message, this.catalogFailure.cause ?? '');
  }

  clear() {
    this.failure = null;
    this.catalogFailure = null;
    this.failedDates = [];
    this.progress = null;
  }

  /** Status of one day for the date picker, while a run is going or just failed. */
  dayStatus(date: number): DayStatus | 'failed' | null {
    if (this.failedDates.includes(date)) return 'failed';
    return this.progress?.days[date] ?? null;
  }
}

export const loading = new LoadingState();
