// How a service day was measured, as a name. The engine decides this once per day, and
// the name travels with the day's results, so nothing downstream has to work it out
// from counts that happen to be zero or from the wording of a note.

export type DayMethod =
  | 'schedule'                 // positions compared with the schedule in force that day
  | 'schedule_later'           // compared with a schedule the archive only captured afterwards
  | 'gps_no_schedule'          // the archive has no schedule covering the day
  | 'gps_schedule_unreadable'  // a schedule covers the day but could not be read
  | 'gps_low_match';           // too few realtime trip IDs are in the schedule to use it

export interface MethodFacts {
  /** A schedule version covers the day. */
  hasSchedule: boolean;
  /** That version was published on or before the day. */
  publishedBefore: boolean;
  /** Reading it failed for a reason other than the connection. */
  scheduleFailed: boolean;
  /** The day has vehicle positions to compare. */
  hasFixes: boolean;
  /** Share of realtime trip IDs found in the schedule, 0 to 1. */
  match: number;
  /** Below this share the schedule is not used. */
  minMatch: number;
}

export function chooseMethod(facts: MethodFacts): DayMethod {
  if (!facts.hasSchedule) return 'gps_no_schedule';
  if (facts.scheduleFailed) return 'gps_schedule_unreadable';
  // With no positions there is nothing to mismatch, and the schedule still says what should have run.
  if (facts.hasFixes && facts.match < facts.minMatch) return 'gps_low_match';
  return facts.publishedBefore ? 'schedule' : 'schedule_later';
}

export const usesSchedule = (method: DayMethod) => method === 'schedule' || method === 'schedule_later';

export const METHOD_LABEL: Record<DayMethod, string> = {
  schedule: 'Schedule',
  schedule_later: 'Schedule, captured later',
  gps_no_schedule: 'GPS only: no schedule',
  gps_schedule_unreadable: 'GPS only: schedule unreadable',
  gps_low_match: 'GPS only: trip IDs don’t match',
};

export const METHOD_NOTE: Record<DayMethod, string> = {
  schedule: 'Positions were compared with the schedule in force on the day.',
  schedule_later: 'Positions were compared with a schedule the archive captured after the day, the earliest one that covers it.',
  gps_no_schedule: 'The archive has no schedule covering the day, so only speeds are measured.',
  gps_schedule_unreadable: 'A schedule covers the day but could not be read, so only speeds are measured.',
  gps_low_match: 'Fewer than a tenth of realtime trip IDs are in the schedule, so it was not used and only speeds are measured.',
};

interface DayLike { date: string; method?: DayMethod | null }

/**
 * Adds `method` to each day of a report. Null for a day saved before the method was
 * kept: its results are unchanged, but how they were made was not recorded.
 */
export function withMethod<T extends {days: DayLike[]}>(report: T, methods: ReadonlyMap<number, DayMethod>): T {
  for (const day of report.days) day.method = methods.get(Number(day.date.replaceAll('-', ''))) ?? null;
  return report;
}
