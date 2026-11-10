// The share of realtime trip IDs found in the schedule, per day, as a number. The engine
// measures it while it analyzes a day and states it only in a note when it is below 80%.
// The worker keeps the number itself and puts it on each row of the day report, so
// nothing downstream has to read it back out of a sentence.

/** What older saved days said in their notes, before the number was kept. */
const LEGACY_NOTE = /(\d+(?:\.\d+)?)% of realtime trip IDs match/;

/** Reads the rate out of a note written by an earlier version. Null when it gives none. */
export function matchFromLegacyNotes(warnings: readonly string[]): number | null {
  for (const warning of warnings) {
    const found = LEGACY_NOTE.exec(warning);
    if (found) return Number(found[1]) / 100;
  }
  return null;
}

interface DayLike { date: string; warnings: string[]; trip_match?: number | null }

/**
 * Adds `trip_match` to each day of an overview: 0 to 1 when a schedule was joined and
 * positions were compared with it, null when it was not measured (a GPS-only day, or a
 * saved day from before the number was kept whose notes state none).
 */
export function withTripMatch<T extends {days: DayLike[]}>(overview: T, matches: ReadonlyMap<number, number | null>): T {
  for (const day of overview.days) {
    const key = Number(day.date.replaceAll('-', ''));
    const known = matches.get(key);
    day.trip_match = known !== undefined ? known : matchFromLegacyNotes(day.warnings);
  }
  return overview;
}
