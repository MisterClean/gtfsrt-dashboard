// The life of one service day, as one status instead of several lists that have to be
// read together. Pure functions over an immutable map, so every transition can be tested
// without a browser. The app state holds one of these maps per open agency.

export type DayStatus =
  | 'idle'       // nothing in memory: either never asked for, or stopped before it finished
  | 'queued'     // waiting its turn, in the current run or the one that follows it
  | 'reading'    // its archive files are being read
  | 'analyzing'  // its positions are being turned into results
  | 'loaded'     // its results are in memory and count toward what is on screen
  | 'no_data'    // the archive has nothing for it
  | 'failed';    // the run that was working on it failed

export interface DayRecord {
  status: DayStatus;
  /** Its results are kept on this device, so loading it needs no download. */
  saved: boolean;
  /** Loaded, but part of the day was missing from the archive. Not saved, so it is read again next visit. */
  partial: boolean;
  /** Loaded from this device rather than from the archive. */
  fromDevice: boolean;
  /** Why there is no data, or what went wrong. */
  reason: string | null;
}

export type Days = Readonly<Record<number, DayRecord>>;

const BLANK: DayRecord = Object.freeze({status: 'idle', saved: false, partial: false, fromDevice: false, reason: null});

export const dayOf = (days: Days, date: number): DayRecord => days[date] ?? BLANK;

const IN_FLIGHT: ReadonlySet<DayStatus> = new Set(['queued', 'reading', 'analyzing']);
export const inFlight = (record: DayRecord) => IN_FLIGHT.has(record.status);
/** Still to do, and worth asking for: a day with no data is not, until someone asks to check again. */
export const isPending = (record: DayRecord) => record.status === 'idle' || record.status === 'failed';

export const datesWhere = (days: Days, test: (record: DayRecord) => boolean) =>
  Object.keys(days).map(Number).filter(date => test(days[date])).sort((a, b) => a - b);

function set(days: Days, date: number, change: Partial<DayRecord>): Days {
  return {...days, [date]: {...dayOf(days, date), ...change}};
}

/** Takes the device's own list of saved days as the truth about what is saved. */
export function markSaved(days: Days, savedDates: readonly number[]): Days {
  const saved = new Set(savedDates);
  const next: Record<number, DayRecord> = {};
  for (const date of new Set([...Object.keys(days).map(Number), ...savedDates])) {
    const record = {...dayOf(days, date), saved: saved.has(date)};
    // A day with nothing to say about it needs no record.
    if (record.saved || record.status !== 'idle') next[date] = record;
  }
  return next;
}

/** Puts days in line. A loaded day stays loaded, and a day already in line keeps its place. */
export function queueDays(days: Days, dates: readonly number[]): Days {
  let next = days;
  for (const date of dates) {
    const record = dayOf(next, date);
    if (record.status === 'loaded' || inFlight(record)) continue;
    next = set(next, date, {status: 'queued', partial: false, reason: null});
  }
  return next;
}

/** Takes days out of line, such as ones deselected while they waited for the next run. */
export function releaseDays(days: Days, dates: readonly number[]): Days {
  let next = days;
  for (const date of dates) if (dayOf(next, date).status === 'queued') next = set(next, date, {status: 'idle'});
  return markSaved(next, datesWhere(next, record => record.saved));
}

/** The fields of the worker's events that a day's status depends on. */
export type DayEvent =
  | {event: 'stage'; phase?: string; date?: number}
  | {event: 'day'; date: number; cached: boolean; saved?: boolean; partial?: boolean}
  | {event: 'unavailable'; date: number; reason: string}
  | {event: string};

/**
 * Applies one worker event. `scope` is the days the current run is working on: a day
 * queued for the run after it must not be mistaken for the one being read.
 */
export function reduceDays(days: Days, event: DayEvent, scope: readonly number[]): Days {
  switch (event.event) {
    case 'stage': {
      const stage = event as {event: 'stage'; phase?: string; date?: number};
      if (stage.phase === 'analyze' && stage.date !== undefined && scope.includes(stage.date)) {
        return dayOf(days, stage.date).status === 'loaded' ? days : set(days, stage.date, {status: 'analyzing'});
      }
      if (stage.phase === 'read') {
        // Files are read in date order, so the first day still waiting is the one being read.
        const active = [...scope].sort((a, b) => a - b).find(date => ['queued', 'reading'].includes(dayOf(days, date).status));
        if (active !== undefined && dayOf(days, active).status !== 'reading') return set(days, active, {status: 'reading'});
      }
      return days;
    }
    case 'day': {
      const day = event as {event: 'day'; date: number; cached: boolean; saved?: boolean; partial?: boolean};
      return set(days, day.date, {status: 'loaded', saved: day.saved ?? day.cached, partial: day.partial ?? false, fromDevice: day.cached, reason: null});
    }
    case 'unavailable': {
      const day = event as {event: 'unavailable'; date: number; reason: string};
      return set(days, day.date, {status: 'no_data', saved: false, partial: false, reason: day.reason});
    }
    default:
      return days;
  }
}

export type Outcome = {kind: 'finished'} | {kind: 'stopped'} | {kind: 'failed'; reason: string};

/**
 * Closes a run. Whatever it left unfinished failed with it, or goes back to idle when
 * the run was stopped. Days queued for the next run keep their place whatever happened:
 * they are saved on this device, so loading them depends on nothing that went wrong.
 */
export function settleDays(days: Days, outcome: Outcome, scope: readonly number[]): Days {
  const inScope = new Set(scope);
  const next: Record<number, DayRecord> = {};
  for (const [key, record] of Object.entries(days)) {
    const date = Number(key);
    if (!inFlight(record)) next[date] = record;
    else if (!inScope.has(date)) next[date] = record;
    else if (outcome.kind === 'failed') next[date] = {...record, status: 'failed', reason: outcome.reason};
    else next[date] = {...record, status: 'idle'};
  }
  return markSaved(next, datesWhere(next, record => record.saved));
}

/** What to call a day's status beside its date. Null when there is nothing worth saying. */
export function statusLabel(record: DayRecord): string | null {
  switch (record.status) {
    case 'queued': return 'waiting';
    case 'reading': return 'reading';
    case 'analyzing': return 'analyzing';
    case 'no_data': return 'no data';
    case 'failed': return 'failed';
    case 'loaded': return record.partial ? 'partly in the archive' : null;
    default: return null;
  }
}

/** The same, for a list of the days in a run, where every day says something. */
export function runLabel(record: DayRecord): string {
  if (record.status === 'loaded') return record.partial ? 'done, partly in the archive' : record.fromDevice ? 'from this device' : 'done';
  return statusLabel(record) ?? 'waiting';
}
