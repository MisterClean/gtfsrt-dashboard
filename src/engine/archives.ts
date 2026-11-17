import {ARCHIVE, DEFAULT_ARCHIVE_ID, MAX_METADATA_BYTES, archiveObjectURL, enforceObjectSize} from './contracts.js';
import type {ArchiveInfo, Feed, FeedRef} from './types.ts';

export interface ArchiveObject {
  url: string;
  credentials: RequestCredentials;
  /** The committed size, when published by the archive. */
  bytes?: number;
  /** Coverage before the first observed poll is unknown on the initial partition. */
  firstPartition?: boolean;
}

type ResolveObject = (path: string) => ArchiveObject;

export interface FeedArchive {
  position(utcDate: string): Promise<ArchiveObject | null>;
  /** Resolve gtfsrt.io-compatible static tables, when this source publishes them. */
  schedule: ResolveObject | null;
  timezone?: string;
}

export interface ArchiveSource {
  info: ArchiveInfo;
  catalog(): Promise<Feed[]>;
  open(feed: Feed, signal: AbortSignal): FeedArchive;
}

const SOURCE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FEED_KEY = /^[A-Za-z0-9_-]{1,2048}$/;
const SHA256 = /^[a-f0-9]{64}$/;

/** The original archive retains its existing IndexedDB keys. */
export function scopedFeedKey({sourceId, feedKey}: FeedRef) {
  if (typeof sourceId !== 'string' || typeof feedKey !== 'string' || !SOURCE_ID.test(sourceId) || !FEED_KEY.test(feedKey)) {
    throw new Error('Invalid archive or feed ID.');
  }
  return sourceId === DEFAULT_ARCHIVE_ID ? feedKey : `${sourceId}/${feedKey}`;
}

function objectResolver(root: string, credentials: RequestCredentials): ResolveObject {
  return path => ({url: archiveObjectURL(root, path), credentials});
}

export function fetchArchive(object: ArchiveObject, init: RequestInit = {}, timeout = 30_000) {
  return fetch(object.url, {
    ...init, signal: withTimeout(init.signal, timeout),
    credentials: object.credentials, redirect: 'error', referrerPolicy: 'no-referrer',
  });
}

function withTimeout(signal: AbortSignal | null | undefined, ms: number) {
  const timeout = AbortSignal.timeout(ms);
  if (!signal) return timeout;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeout]);
  // Older Safari and Firefox need a manual merge.
  const merged = new AbortController();
  for (const source of [signal, timeout]) {
    if (source.aborted) merged.abort(source.reason);
    else source.addEventListener('abort', () => merged.abort(source.reason), {once: true});
  }
  return merged.signal;
}

export function readBlob(response: Response, maxBytes: number, label: string) {
  if (!response.body || Number(response.headers.get('content-length')) > maxBytes) {
    void response.body?.cancel().catch(() => {});
    throw new Error(`${label} is larger than expected or has no body.`);
  }
  let bytes = 0;
  const limited = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) throw new Error(`${label} is larger than expected.`);
      controller.enqueue(chunk);
    },
  }));
  return new Response(limited).blob();
}

/** Only 404 means absent. Access and network failures must surface to the visitor. */
async function readJson(object: ArchiveObject, label: string, signal?: AbortSignal, timeout?: number) {
  const response = await fetchArchive(object, {cache: 'no-cache', signal}, timeout);
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}.`);
  return JSON.parse(await (await readBlob(response, MAX_METADATA_BYTES, label)).text()) as unknown;
}

const JSON_FRESH_MS = 5 * 60_000;
const jsonCache = new Map<string, {at: number; value: Promise<unknown>}>();

/** Revalidate shared catalogs after five minutes and drop failures immediately. */
export function archiveJson(object: ArchiveObject, label: string, timeout?: number) {
  const kept = jsonCache.get(object.url);
  if (kept && Date.now() - kept.at < JSON_FRESH_MS) return kept.value;
  const value = readJson(object, label, undefined, timeout).then(data => {
    if (data === undefined) throw new Error(`${label} returned HTTP 404.`);
    return data;
  });
  jsonCache.set(object.url, {at: Date.now(), value});
  void value.catch(() => {
    if (jsonCache.get(object.url)?.value === value) jsonCache.delete(object.url);
  });
  return value;
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString().slice(0, 10) === value;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isPositionFeed(feed: unknown): feed is Feed {
  return record(feed) && feed.feed_type === 'vehicle_positions' &&
    typeof feed.base64url === 'string' && FEED_KEY.test(feed.base64url) &&
    isIsoDate(feed.date_min) && isIsoDate(feed.date_max) && feed.date_min <= feed.date_max;
}

async function inventory(object: ArchiveObject, label: string) {
  const data = await archiveJson(object, `${label} inventory`, 90_000);
  if (!Array.isArray(data) || data.length > 5000) throw new Error(`${label} has an invalid feed catalog.`);
  return data.filter(isPositionFeed);
}

function positionPath(utcDate: string, feedKey: string) {
  return `vehicle_positions/date=${utcDate}/base64url=${feedKey}/data.parquet`;
}

function publicArchive(): ArchiveSource {
  const object = objectResolver(ARCHIVE, 'omit');
  const info = {id: DEFAULT_ARCHIVE_ID, label: 'gtfsrt.io', website: 'https://gtfsrt.io/'};
  return {
    info,
    catalog: () => inventory(object('inventory.json'), info.label),
    open: feed => ({
      schedule: object,
      position: async date => object(positionPath(date, feed.base64url)),
    }),
  };
}

async function committedPosition(object: ResolveObject, feed: Feed, date: string, signal: AbortSignal) {
  const agency = feed.agency_id;
  if (typeof agency !== 'string' || !SOURCE_ID.test(agency)) throw new Error('Invalid agency ID in the committed archive.');
  const label = `Archive commit for ${agency} on ${date}`;
  const manifest = await readJson(object(`commits/agency=${agency}/date=${date}/manifest.json`), label, signal);
  if (manifest === undefined) return null;
  if (!record(manifest) || manifest.schema_version !== 1 || manifest.agency !== agency || manifest.date !== date ||
      typeof manifest.generation !== 'string' || !SHA256.test(manifest.generation) || !Array.isArray(manifest.files)) {
    throw new Error(`${label} is invalid.`);
  }
  const canonical = `compat/v1/${positionPath(date, feed.base64url)}`;
  const files = manifest.files.filter(file => record(file) && file.canonical_key === canonical);
  if (!files.length) return null;
  const [file] = files;
  const path = `generations/${manifest.generation}/${positionPath(date, feed.base64url)}`;
  if (files.length !== 1 || file.table !== 'vehicle_positions' || file.date !== date || file.path !== `compat/v1/${path}` ||
      typeof file.sha256 !== 'string' || !SHA256.test(file.sha256) || typeof file.bytes !== 'number') {
    throw new Error(`${label} has an invalid position object.`);
  }
  return {...object(path), bytes: enforceObjectSize(file.bytes, label), firstPartition: date === feed.date_min};
}

function committedArchive(baseUrl: string, info: ArchiveInfo, schedules: boolean, timezones: ReadonlyMap<string, string>): ArchiveSource {
  const object = objectResolver(new URL(`archives/${info.id}/compat/v1/`, baseUrl).href, 'same-origin');
  return {
    info,
    catalog: () => inventory(object('inventory.json'), info.label),
    open(feed, signal) {
      // The time zone probe and the subsequent plan must see the same generation.
      const positions = new Map<string, Promise<ArchiveObject | null>>();
      return {
        schedule: schedules ? object : null,
        timezone: feed.agency_id ? timezones.get(feed.agency_id) : undefined,
        position(date) {
          let position = positions.get(date);
          if (!position) {
            position = committedPosition(object, feed, date, signal);
            positions.set(date, position);
            void position.catch(() => positions.delete(date));
          }
          return position;
        },
      };
    },
  };
}

function configuredTimezones(value: unknown) {
  const timezones = new Map<string, string>();
  if (value === undefined) return timezones;
  if (!record(value)) throw new Error('Archive time zones must be an object keyed by agency ID.');
  for (const [agency, zone] of Object.entries(value)) {
    if (!SOURCE_ID.test(agency) || typeof zone !== 'string') throw new Error('Invalid agency time zone in archive-sources.json.');
    new Intl.DateTimeFormat('en', {timeZone: zone});
    timezones.set(agency, zone);
  }
  return timezones;
}

/** The host may add any number of same-origin committed archives without rebuilding the app. */
export async function loadArchives(baseUrl: string) {
  const builtIn = publicArchive();
  const sources = new Map([[builtIn.info.id, builtIn]]);
  const config = await readJson({url: new URL('archive-sources.json', baseUrl).href, credentials: 'same-origin'}, 'Archive configuration');
  if (config === undefined) return sources;
  if (!Array.isArray(config)) throw new Error('archive-sources.json must contain an array of archives.');
  for (const entry of config) {
    if (!record(entry) || typeof entry.id !== 'string' || !SOURCE_ID.test(entry.id) || sources.has(entry.id) ||
        typeof entry.label !== 'string' || !entry.label.trim() || entry.label.length > 80 ||
        (entry.schedules !== undefined && typeof entry.schedules !== 'boolean') ||
        (entry.signIn !== undefined && typeof entry.signIn !== 'boolean')) {
      throw new Error('Invalid archive entry in archive-sources.json.');
    }
    const info: ArchiveInfo = {id: entry.id, label: entry.label};
    if (entry.signIn) info.signInUrl = new URL(`archives/${entry.id}/sign-in`, baseUrl).href;
    sources.set(entry.id, committedArchive(baseUrl, info, entry.schedules === true, configuredTimezones(entry.timezones)));
  }
  return sources;
}
