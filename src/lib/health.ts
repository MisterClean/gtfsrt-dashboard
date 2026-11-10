// Feed health: what we know about an archive feed before anyone downloads it.
// Pure functions shared by scripts/validate-feeds.mjs (which writes
// public/feed-health.json, with src/data/feed-overrides.json already applied)
// and the app (which reads that file), so both agree on what a status means.

export type HealthStatus = 'ok' | 'stale' | 'gps_only' | 'low_match' | 'thin' | 'empty';

export interface FeedFacts {
  agency_id: string | null;
  system_id: string | null;
  date_min: string;
  date_max: string;
  total_records: number;
  total_bytes: number;
}

export interface FeedHealth {
  status: HealthStatus;
  /** One line, shown beside the badge. Null when the feed is fine. */
  reason: string | null;
  /** Rounded to the nearest 10 MB so the committed file only changes when the size class does. */
  approx_bytes_per_day: number;
  /** Share of realtime trip IDs found in the schedule, 0 to 1. Null when not measured. */
  trip_match: number | null;
  trips_per_day: number | null;
  large: boolean;
  /** Whether the newest object answered a HEAD request. Null when not probed. */
  head_ok: boolean | null;
  note: string | null;
  hidden: boolean;
}

export interface FeedOverride {
  /** Hide from the default list (still reachable through "show all"). */
  hide?: boolean;
  /** Shown beside the feed, for things the probe can't see. */
  note?: string;
  /** Force a status. Beats everything the probe derived. */
  status?: HealthStatus;
  /** Replace the generated one-line reason. */
  reason?: string;
  /** Facts the probe can't cheaply measure. They feed the classification. */
  trip_match?: number;
  trips_per_day?: number;
  large?: boolean;
}

export const STALE_DAYS = 14;
export const MATCH_FLOOR = 0.5;
export const THIN_TRIPS = 500;
/** Roughly the point where a day's file is slow enough to warn about. */
export const LARGE_BYTES_PER_DAY = 60 * 1024 * 1024;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_MS = 86_400_000;

export const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);

export function addIsoDays(iso: string, days: number) {
  return new Date(Date.parse(iso) + days * DAY_MS).toISOString().slice(0, 10);
}

export function shortDate(iso: string) {
  const [, month, day] = iso.split('-').map(Number);
  return `${MONTHS[month - 1]} ${day}`;
}

type Ids = {agency_id: string | null; system_id: string | null};

/** A readable id for bug reports, such as "septa/rail". */
export const feedId = (feed: Ids) => [feed.agency_id, feed.system_id].filter(Boolean).join('/') || 'unknown';

/** Nearest 10 MB, never zero for a feed that has data. */
export const sizeClass = (bytes: number) => Math.max(1, Math.round(bytes / TEN_MB)) * TEN_MB;
const TEN_MB = 10 * 1024 * 1024;

export function approxBytesPerDay(feed: Pick<FeedFacts, 'date_min' | 'date_max' | 'total_bytes'>) {
  const span = Math.max(1, daysBetween(feed.date_min, feed.date_max) + 1);
  return Math.round(feed.total_bytes / span);
}

export interface ClassifyInput {
  facts: FeedFacts;
  /** Newest archive day across every feed. Staleness is measured against this, not the clock. */
  reference: string;
  trip_match?: number | null;
  trips_per_day?: number | null;
  /** False when a day could not be joined to a schedule at all. */
  schedule_join?: boolean | null;
}

/** Worst problem first: a feed with no data is empty even if it also looks thin. */
export function classify({facts, reference, trip_match = null, trips_per_day = null, schedule_join = null}: ClassifyInput):
  {status: HealthStatus; reason: string | null} {
  if (!(facts.total_records > 0) || !(facts.total_bytes > 0)) return {status: 'empty', reason: REASONS.empty(facts)};
  if (daysBetween(facts.date_max, reference) > STALE_DAYS) return {status: 'stale', reason: REASONS.stale(facts)};
  if (schedule_join === false) return {status: 'gps_only', reason: REASONS.gps_only(facts)};
  if (trip_match !== null && trip_match < MATCH_FLOOR) return {status: 'low_match', reason: `Only ${Math.round(trip_match * 100)}% of trip IDs match the schedule`};
  if (trips_per_day !== null && trips_per_day < THIN_TRIPS) return {status: 'thin', reason: `Thin service (${trips_per_day} trips a day): hourly figures are noisy`};
  return {status: 'ok', reason: null};
}

const REASONS = {
  empty: (_: FeedFacts) => 'No data in the archive',
  stale: (f: FeedFacts) => `Data ends ${shortDate(addIsoDays(f.date_max, -1))}`,
  gps_only: (_: FeedFacts) => 'GPS speeds only — no schedule match',
  low_match: (_: FeedFacts) => 'Many trip IDs do not match the schedule',
  thin: (_: FeedFacts) => 'Thin service: hourly figures are noisy',
  ok: (_: FeedFacts) => null,
};

/** The most specific override wins: "septa/rail" over "septa". */
export function findOverride(overrides: Record<string, FeedOverride>, feed: Ids) {
  for (const key of [feedId(feed), feed.agency_id]) if (key && overrides[key]) return overrides[key];
  return undefined;
}

/** One feed's health: measured and override facts classified, then overrides applied on top. */
export function resolveHealth(args: {
  facts: FeedFacts;
  reference: string;
  override?: FeedOverride;
  measured?: {trip_match?: number | null; trips_per_day?: number | null; schedule_join?: boolean | null; head_ok?: boolean | null};
}): FeedHealth {
  const {facts, reference, override, measured = {}} = args;
  const trip_match = override?.trip_match ?? measured.trip_match ?? null;
  const trips_per_day = override?.trips_per_day ?? measured.trips_per_day ?? null;
  const derived = classify({facts, reference, trip_match, trips_per_day, schedule_join: measured.schedule_join});
  const status = override?.status ?? derived.status;
  const reason = status === 'ok' ? null : override?.reason ?? (status === derived.status ? derived.reason : REASONS[status](facts));
  const bytes = approxBytesPerDay(facts);
  return {
    status,
    reason,
    approx_bytes_per_day: sizeClass(bytes),
    trip_match,
    trips_per_day,
    large: override?.large ?? bytes >= LARGE_BYTES_PER_DAY,
    head_ok: measured.head_ok ?? null,
    note: override?.note ?? null,
    hidden: override?.hide ?? status === 'empty',
  };
}

export type HealthGroup = 'working' | 'limited' | 'stale' | 'unknown';
export const groupOf = (status: HealthStatus | null): HealthGroup =>
  status === null ? 'unknown' : status === 'ok' ? 'working' : status === 'stale' || status === 'empty' ? 'stale' : 'limited';

export const STATUS_BADGE: Record<HealthStatus, string> = {
  ok: 'Working', stale: 'Out of date', gps_only: 'GPS only', low_match: 'Low match', thin: 'Thin', empty: 'No data',
};

/** No timestamps: the file only changes when a status, size class or note does. */
export interface HealthFile { schema: 1; feeds: Record<string, FeedHealth> }

/** Tolerant: a missing or malformed file leaves every feed "unknown" and still selectable. */
export function parseHealthFile(value: unknown): Record<string, FeedHealth> {
  if (!value || typeof value !== 'object' || (value as HealthFile).schema !== 1) return {};
  const feeds = (value as HealthFile).feeds;
  if (!feeds || typeof feeds !== 'object') return {};
  const valid = new Set(['ok', 'stale', 'gps_only', 'low_match', 'thin', 'empty']);
  return Object.fromEntries(Object.entries(feeds).filter(([, h]) => h && valid.has(h.status)));
}

/** Staleness against the clock. Separate from the archive-relative status: a whole archive can fall behind. */
export function staleness(feed: {date_max: string}, today: string) {
  const latest_day = addIsoDays(feed.date_max, -1);
  return {stale: daysBetween(latest_day, today) > STALE_DAYS, latest_day};
}
