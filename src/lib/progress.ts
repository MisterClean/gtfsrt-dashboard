// Progress for one analysis run, as a pure reducer over the worker's events so it can be
// tested without a browser. The bar only ever moves forward: stages that don't know
// their own fraction (reading a schedule, starting the database) keep the last one.

export type Phase = 'database' | 'lookup' | 'read' | 'schedule' | 'analyze';

export interface Progress {
  startedAt: number;
  message: string;
  phase: Phase | null;
  fraction: number;
  dayIndex: number;
  dayCount: number;
  /** Archive bytes scanned so far, by file size and position. Null until the sizes are known. */
  bytesDone: number | null;
  bytesTotal: number | null;
}

/** The fields of the worker's `stage` event that progress cares about. */
export interface StageInfo {
  message: string;
  fraction?: number;
  dayIndex?: number;
  dayCount?: number;
  phase?: Phase;
  bytesDone?: number;
  bytesTotal?: number;
  /** The service day being worked on, when there is one. */
  date?: number;
}

export type ProgressEvent =
  | ({event: 'stage'} & StageInfo)
  | {event: string};

export function startProgress(dates: number[], now = Date.now()): Progress {
  return {startedAt: now, message: 'Starting', phase: null, fraction: 0, dayIndex: 0, dayCount: dates.length, bytesDone: null, bytesTotal: null};
}

/** Which day is where belongs to days.ts. This is only the bar and the words beside it. */
export function reduceProgress(progress: Progress, event: ProgressEvent): Progress {
  if (event.event !== 'stage') return progress;
  const stage = event as {event: 'stage'} & StageInfo;
  return {
    ...progress,
    message: stage.message,
    phase: stage.phase ?? progress.phase,
    // Never backwards, and clamped so a bad value can't overshoot.
    fraction: Math.min(1, Math.max(progress.fraction, stage.fraction ?? 0)),
    dayIndex: Math.max(progress.dayIndex, stage.dayIndex ?? 0),
    dayCount: stage.dayCount || progress.dayCount,
    // Byte totals can grow as more files are sized, but what's been read can't shrink.
    bytesDone: stage.bytesDone === undefined ? progress.bytesDone : Math.max(progress.bytesDone ?? 0, stage.bytesDone),
    bytesTotal: stage.bytesTotal ?? progress.bytesTotal,
  };
}

/** m:ss, or h:mm:ss for very long runs. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = String(total % 60).padStart(2, '0');
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}:${seconds}`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${seconds}`;
}

// ---- Heads-up before a download -------------------------------------------

/**
 * Measured on the live archive from a fast home connection: 5 weekdays of NYC Bus, 1.2 GB
 * of archive files, took about 140 s. Slower connections will take longer, so the wording
 * says "about", never promises.
 */
const BYTES_PER_SECOND = 8e6;
const FIXED_SECONDS = 10;
const LARGE_BYTES = 250e6;
const HUGE_BYTES = 1e9;

export interface LoadEstimate {
  /** Upper bound on archive bytes for the days not yet on this device. */
  bytes: number;
  seconds: number;
  level: 'small' | 'large' | 'huge';
}

const isoOf = (date: number) => `${String(date).slice(0, 4)}-${String(date).slice(4, 6)}-${String(date).slice(6, 8)}`;
const nextIso = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);

/**
 * What a download will cost, from the catalog's own totals: the archive's size spread
 * over its days, times the UTC files the days touch (a service day spans two). It is an
 * upper bound, since only some columns are read, and says so.
 */
export function estimateLoad(feed: {date_min: string; date_max: string; total_bytes: number}, uncachedDates: number[]): LoadEstimate {
  if (!uncachedDates.length) return {bytes: 0, seconds: 0, level: 'small'};
  const span = (Date.parse(feed.date_max) - Date.parse(feed.date_min)) / 86400000 + 1;
  const perFile = feed.total_bytes / Math.max(1, span);
  const files = new Set<string>();
  for (const date of uncachedDates) {
    files.add(isoOf(date));
    files.add(nextIso(isoOf(date)));
  }
  const bytes = files.size * perFile;
  return {
    bytes,
    seconds: Math.round(FIXED_SECONDS + bytes / BYTES_PER_SECOND),
    level: bytes >= HUGE_BYTES ? 'huge' : bytes >= LARGE_BYTES ? 'large' : 'small',
  };
}

export function durationLabel(seconds: number): string {
  if (seconds < 90) return `about ${Math.max(10, Math.round(seconds / 10) * 10)} seconds`;
  return `about ${Math.round(seconds / 60)} minutes`;
}

// ---- What the progress panel says about size ---------------------------------

export interface SizeReport {
  /** Archive bytes expected: the files' real sizes once known, else the catalog estimate. */
  total: number;
  /** True when `total` is the sum of real file sizes rather than the catalog estimate. */
  exact: boolean;
  /** Bytes scanned so far. Null until the first bytes arrive, so "0 KB" is never shown. */
  done: number | null;
}

/**
 * One size source for the whole page: the catalog estimate (the same figure as the top
 * bar) until the files have been sized, then their real total. Nothing is reported as
 * done before anything has been.
 */
export function sizeReport(progress: Pick<Progress, 'bytesDone' | 'bytesTotal'>, estimate: number): SizeReport {
  const exact = progress.bytesTotal !== null && progress.bytesTotal > 0;
  const total = exact ? progress.bytesTotal! : estimate;
  const done = progress.bytesDone !== null && progress.bytesDone > 0 ? Math.min(progress.bytesDone, total || progress.bytesDone) : null;
  return {total, exact, done};
}

/** No share to show yet: before the first bytes arrive a bar can only say "working". */
export const isIndeterminate = (progress: Pick<Progress, 'fraction'>) => progress.fraction <= 0;
