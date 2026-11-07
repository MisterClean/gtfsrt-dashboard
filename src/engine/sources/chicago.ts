import {CHICAGO_POSITIONS, MAX_METADATA_BYTES, chicagoPositionURL, isDigest} from '../contracts.js';
import type {Feed, PositionProvenance} from '../types.ts';
import {readPositionBytes, sha256, verifiedPositionBytes} from './daily.ts';
import type {DailyObject} from './daily.ts';

const SOURCE = 'Chicago Transit Alerts';
const SOURCE_URL = 'https://chicagotransitalerts.app/subscribe/#use-the-data';
export const CHICAGO_TIMEZONE = 'America/Chicago';
export const CHICAGO_FEEDS = {
  'chicago-transit-alerts-bus': 'bus',
  'chicago-transit-alerts-rail': 'train',
} as const;
type FeedKey = keyof typeof CHICAGO_FEEDS;

export function isChicagoFeed(key: string): key is FeedKey {
  return Object.hasOwn(CHICAGO_FEEDS, key);
}

function malformed(): never {
  throw new Error('Chicago Transit Alerts returned an unsupported or invalid positions manifest.');
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return malformed();
  return value as Record<string, unknown>;
}

function digest(value: unknown): string {
  if (typeof value !== 'string' || !isDigest(value)) return malformed();
  return value;
}

function count(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) return malformed();
  return value;
}

function dateKey(value: unknown): string {
  if (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(value)) return malformed();
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) return malformed();
  return value;
}

function instant(value: unknown): number {
  if (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return malformed();
  const time = Date.parse(value) / 1000;
  if (!Number.isFinite(time)) return malformed();
  return time;
}

export interface ChicagoArchive {
  manifest: string;
  objects: Map<FeedKey, Map<string, DailyObject>>;
  gaps: Map<FeedKey, PositionProvenance['gaps']>;
}

/** The immutable index is held for one run. No paths come from user input. */
export async function openChicagoArchive(pin?: string, signal?: AbortSignal): Promise<ChicagoArchive> {
  async function json(url: string, sha?: string, size?: number) {
    const response = await chicagoFetch(url, signal);
    if (!response.ok) throw new Error(`Chicago Transit Alerts returned HTTP ${response.status} for the positions catalog.`);
    const bytes = sha && size !== undefined
      ? await verifiedPositionBytes(response, size, sha, MAX_METADATA_BYTES)
      : await readPositionBytes(response, sha ? MAX_METADATA_BYTES : 4096);
    // Pinned links only contain a digest, so the manifest's size isn't known yet.
    if (sha && size === undefined && await sha256(bytes) !== sha) return malformed();
    return record(JSON.parse(new TextDecoder().decode(bytes)));
  }

  let sha: string;
  let size: number | undefined;
  if (pin !== undefined) {
    sha = digest(pin);
  } else {
    const pointer = await json(chicagoPositionURL('positions/index.json'));
    if (pointer.manifest_version !== 2) return malformed();
    sha = digest(pointer.sha256);
    size = count(pointer.bytes, 1, MAX_METADATA_BYTES);
    if (pointer.path !== `positions/manifests/${sha}.json`) return malformed();
  }
  const manifest = await json(chicagoPositionURL(`positions/manifests/${sha}.json`), sha, size);
  return parseChicagoManifest(manifest, sha);
}

export function chicagoFetch(url: string, signal?: AbortSignal) {
  if (!url.startsWith(CHICAGO_POSITIONS) || chicagoPositionURL(new URL(url).pathname.slice(1)) !== url) {
    throw new Error('Only the Chicago Transit Alerts position archive is allowed.');
  }
  const timeout = AbortSignal.timeout(30_000);
  return fetch(url, {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
  });
}

export function parseChicagoManifest(manifest: Record<string, unknown>, sha: string): ChicagoArchive {
  if (manifest.manifest_version !== 2 || manifest.schema_version !== 2 ||
      manifest.timezone !== CHICAGO_TIMEZONE || manifest.format !== 'parquet' ||
      !Array.isArray(manifest.days) || !Array.isArray(manifest.known_gaps)) return malformed();

  const keys = Object.keys(CHICAGO_FEEDS) as FeedKey[];
  const objects: ChicagoArchive['objects'] = new Map(keys.map(key => [key, new Map()]));
  const gaps: ChicagoArchive['gaps'] = new Map(keys.map(key => [key, []]));
  const dates = new Set<string>();
  for (const value of manifest.days) {
    const day = record(value);
    const date = dateKey(day.date);
    if (dates.has(date)) return malformed();
    dates.add(date);
    const files = record(day.files);
    for (const key of keys) {
      const mode = CHICAGO_FEEDS[key];
      if (files[mode] == null) continue;
      const file = record(files[mode]);
      if (file.format !== 'parquet' || file.schema_version !== 2) return malformed();
      const hash = digest(file.sha256);
      const path = `positions/${mode}/${date.slice(0, 4)}/${date.slice(5, 7)}/${date}.${hash}.parquet`;
      if (file.path !== path) return malformed();
      const url = chicagoPositionURL(path);
      const approximate = file.quality == null ? undefined : record(file.quality).approx_rows;
      objects.get(key)!.set(date, {
        handle: {kind: 'verified', url, bytes: count(file.bytes, 1), sha256: hash, fetch: signal => chicagoFetch(url, signal)},
        rows: count(file.rows, 0),
        approximateRows: approximate === undefined ? undefined : count(approximate, 0),
      });
    }
  }
  for (const value of manifest.known_gaps) {
    const gap = record(value);
    const start = instant(gap.start);
    const end = instant(gap.end);
    if (!(end > start) || typeof gap.note !== 'string' || !Array.isArray(gap.feeds)) return malformed();
    const note = gap.note;
    for (const key of keys) {
      if (gap.feeds.includes(CHICAGO_FEEDS[key])) {
        gaps.get(key)!.push({start, end, note, reduced: /^reduced polling\b/i.test(note)});
      }
    }
  }
  for (const list of gaps.values()) list.sort((a, b) => a.start - b.start || a.end - b.end || a.note.localeCompare(b.note));
  return {manifest: sha, objects, gaps};
}

export function chicagoCatalog(archive: ChicagoArchive): Feed[] {
  return [...archive.objects].flatMap(([key, files]) => {
    const dates = [...files.keys()].sort();
    if (!dates.length) return [];
    const bus = CHICAGO_FEEDS[key] === 'bus';
    const bytesByDate = Object.fromEntries([...files].map(([date, file]) => [
      date, file.handle.kind === 'verified' ? file.handle.bytes : file.handle.file.size,
    ]));
    return [{
      base64url: key,
      agency_id: 'cta',
      agency_name: 'Chicago Transit Authority',
      system_id: key,
      system_name: `${bus ? 'Bus' : 'Rail'} (Chicago Transit Alerts)`,
      feed_type: 'vehicle_positions',
      date_min: dates[0],
      date_max: dates[dates.length - 1],
      total_records: [...files.values()].reduce((sum, file) => sum + file.rows, 0),
      total_bytes: Object.values(bytesByDate).reduce((sum, bytes) => sum + bytes, 0),
      positions: {source: SOURCE, url: SOURCE_URL, timezone: CHICAGO_TIMEZONE, mode: bus ? 'Bus' : 'Rail', bytesByDate},
    }];
  });
}

export function chicagoReportTime(key: FeedKey) {
  return CHICAGO_FEEDS[key] === 'bus'
    ? 'Bus Tracker position time, with poll time when the report time is unavailable or implausible.'
    : 'Train Tracker prediction time is used as a proxy for position time, with poll time when it is unavailable or implausible.';
}
