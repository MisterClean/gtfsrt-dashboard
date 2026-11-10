// One place for the rules that decide whether a figure is shown, flagged or withheld,
// and for the definitions printed beside each headline number. Views must use these
// helpers rather than their own cut-offs. docs/metrics.md ("Sample sizes and partial
// days") documents the same values.
import type {DayRow, Overview} from '../engine/types';

/** Fewer events than this and a share is withheld ("too few trips"). Sampling error exceeds 10 points at 50%. */
export const MIN_EVENTS = 20;
/** Below this a shown share carries a "low sample" flag. About 5 points of error at 50%. */
export const SOLID_EVENTS = 100;
/** Days selected before a resampled interval means anything. Mirrors crates/core intervals.minimum_days. */
export const MIN_DAYS_FOR_INTERVAL = 5;
/** An hour has real service when it carries at least this share of the median operating hour. */
export const SERVICE_HOUR_SHARE = 0.5;
/** Share of realtime trip IDs that must match the schedule for on-time and trip metrics to show at all. */
export const MIN_MATCH_TO_SHOW = 0.25;
/** At or above this match rate nothing is flagged. Mirrors NOTE_TRIP_MATCH in the worker. */
export const FULL_MATCH = 0.8;

export const TOO_FEW = 'too few trips';

export type SampleState = 'withheld' | 'low' | 'ok';

export function sampleState(n: number | null | undefined): SampleState {
  if (n === null || n === undefined || !(n >= MIN_EVENTS)) return 'withheld';
  return n < SOLID_EVENTS ? 'low' : 'ok';
}

/** True when a figure over n events may be shown at all (tables, rankings, headlines). */
export const isShown = (n: number | null | undefined) => sampleState(n) !== 'withheld';
/** True when n is enough for a figure that stands alone, such as one hour of the day. */
export const isSolid = (n: number | null | undefined) => sampleState(n) === 'ok';

/** part / whole, or null when whole is too small to report. */
export function share(part: number, whole: number): number | null {
  return isShown(whole) ? part / whole : null;
}

/** Wilson score interval for a proportion. z = 1.96 gives 95%. */
export function wilson(successes: number, n: number, z = 1.96): [number, number] | null {
  if (!(n > 0) || successes < 0 || successes > n) return null;
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/** "n = 1,204", "n = 60, low sample", or "too few trips (n = 12)". */
export function sampleText(n: number): string {
  const count = n.toLocaleString('en-US');
  if (!isShown(n)) return `${TOO_FEW} (n = ${count})`;
  return `n = ${count}${sampleState(n) === 'low' ? ', low sample' : ''}`;
}

// ---- Definitions, printed beside the numbers they describe -----------------

export const DEFINITIONS = {
  ontime: (early: string, late: string) => `Share of departures at timepoints from ${early} to ${late}. Times are interpolated from GPS positions. Where a trip marks no timepoints, every stop counts, and the agency's own figure may differ.`,
  ontimeStops: 'Share of all stop passes inside the on-time window, not only timepoints, so it can disagree with route and network figures.',
  speed: 'Distance travelled divided by time in service, with stops and signals included and terminal layovers excluded.',
  scheduledSpeed: 'Speed implied by the timetable. Scheduled dwell is not counted, which flatters the schedule on long-hold routes.',
  observed: 'Trips seen in the realtime feed divided by trips scheduled. A missing trip may be a cancellation, a feed gap or a trip ID that does not match.',
  headways: 'Frequent service only: stops and times the schedule serves every 15 minutes or better.',
  bunched: 'Vehicles arriving within a quarter of the scheduled headway of the one before. Frequent service only.',
  excessWait: 'Average wait implied by actual headways minus the wait the schedule promises, for a rider arriving at random. Frequent service only. Missing trips lengthen it.',
  gapFloor: 'A floor: gaps longer than the larger of an hour or four scheduled headways are dropped, so the true share is at least this.',
} as const;

// ---- Which days can support schedule-based metrics ------------------------

export type ScheduleMode = 'full' | 'partial' | 'suppressed' | 'gps';

export interface Coverage {
  mode: ScheduleMode;
  /** Lowest share of realtime trip IDs matching the schedule on any day, when the app reported one. */
  matchRate: number | null;
  /** Days with speeds only because no schedule could be joined. */
  gpsDays: number;
  days: number;
}

/** A day with no scheduled trips and no on-time events is a GPS-only day. */
export const isGpsDay = (day: Pick<DayRow, 'trips_scheduled' | 'on_time'>) => day.trips_scheduled === 0 && day.on_time.total === 0;

function scheduleMode(gpsDays: number, days: number, matchRate: number | null, minimum = MIN_MATCH_TO_SHOW): ScheduleMode {
  if (days > 0 && gpsDays === days) return 'gps';
  if (matchRate !== null && matchRate < minimum) return 'suppressed';
  if (gpsDays > 0 || (matchRate !== null && matchRate < FULL_MATCH)) return 'partial';
  return 'full';
}

/**
 * How far the selected days can support on-time, trip and headway figures.
 * gps: no day joined a schedule. suppressed: match rate below MIN_MATCH_TO_SHOW.
 * partial: some days GPS-only, or match rate below FULL_MATCH. full: no caveat.
 */
export function coverageOf(overview: {days: readonly Pick<DayRow, 'trips_scheduled' | 'on_time' | 'trip_match'>[]} | null | undefined): Coverage {
  const days = overview?.days ?? [];
  if (!days.length) return {mode: 'full', matchRate: null, gpsDays: 0, days: 0};
  const gpsDays = days.filter(isGpsDay).length;
  const rates = days.map(day => day.trip_match).filter((r): r is number => typeof r === 'number');
  const matchRate = rates.length ? Math.min(...rates) : null;
  return {mode: scheduleMode(gpsDays, days.length, matchRate), matchRate, gpsDays, days: days.length};
}

export function withMatchRate(coverage: Coverage, matchRate: number | undefined, minimum = MIN_MATCH_TO_SHOW): Coverage {
  if (matchRate === undefined) return coverage;
  const lowest = Math.min(coverage.matchRate ?? matchRate, matchRate);
  return {...coverage, matchRate: lowest, mode: scheduleMode(coverage.gpsDays, coverage.days, lowest, minimum)};
}

/** True when on-time, trip-share and headway figures must not be shown as numbers. */
export const scheduleSuppressed = (c: Coverage) => c.mode === 'gps' || c.mode === 'suppressed';

export function coverageNote(c: Coverage, snapshot = false, minimum = MIN_MATCH_TO_SHOW): string | null {
  const rate = c.matchRate === null ? '' : `${Math.round(c.matchRate * 100)}%`;
  const reports = snapshot ? 'eligible archived position reports' : 'realtime trip IDs';
  switch (c.mode) {
    case 'gps':
      return 'No schedule could be joined to the feed for these days, so only GPS speeds are shown.';
    case 'suppressed':
      return `Only ${rate} of ${reports} match the schedule, below the ${Math.round(minimum * 100)}% needed. On-time, ${snapshot ? 'trip share' : 'trip'} and headway figures are withheld because a subset this small is not representative. ${snapshot ? 'Speeds describe matched positions.' : 'Speeds are unaffected.'}`;
    case 'partial':
      return c.gpsDays > 0
        ? `${c.gpsDays} of ${c.days} days had no schedule, so on-time and trip figures cover only the others.`
        : `Partial: only ${rate} of ${reports} match the schedule, so on-time and trip figures describe the matched trips only.`;
    default:
      return null;
  }
}

// ---- Choosing hours for headlines -------------------------------------------

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Hours fit to name in a "worst hour" headline: enough events to trust, and service
 * weight of at least SERVICE_HOUR_SHARE of the median operating hour, so a lone
 * overnight run cannot be called the slowest or least reliable hour.
 */
export function headlineHours<T>(rows: readonly T[], weight: (row: T) => number, events: (row: T) => number): T[] {
  const weights = rows.map(weight).filter(w => w > 0);
  if (!weights.length) return [];
  const floor = median(weights) * SERVICE_HOUR_SHARE;
  return rows.filter(row => weight(row) >= floor && isShown(events(row)));
}
