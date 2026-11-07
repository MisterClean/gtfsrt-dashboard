// Shared by archives and local imports whose objects cover local calendar days.
import {addDays} from '../../lib/dates.ts';
import type {PositionProvenance} from '../types.ts';

export type PositionHandle =
  | {kind: 'range'; url: string}
  | {kind: 'verified'; url: string; bytes: number; sha256: string; fetch(signal: AbortSignal): Promise<Response>}
  | {kind: 'local'; file: Blob; sha256: string};

export interface DailyObject {
  handle: Exclude<PositionHandle, {kind: 'range'}>;
  rows: number;
  approximateRows?: number;
}

export interface PositionFile {
  date: string;
  start: number;
  end: number;
  windowStart: number;
  windowEnd: number;
  completes: number[];
  handle: PositionHandle | null;
  rows?: number;
}

export interface DailyPlan {
  files: PositionFile[];
  days: Map<number, {window: [number, number]; files: PositionProvenance['files']}>;
}

/** Maps the engine's service windows to actual partition intervals, including DST. */
export function planDailyPositions(
  timezone: string,
  windows: Map<number, [number, number]>,
  objects: ReadonlyMap<string, DailyObject>,
): DailyPlan {
  const formatter = new Intl.DateTimeFormat('en-US', {timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'});
  const localDate = (seconds: number) => {
    const parts = formatter.formatToParts(seconds * 1000);
    const part = (name: string) => parts.find(p => p.type === name)!.value;
    return `${part('year')}-${part('month')}-${part('day')}`;
  };
  const starts = new Map<string, number>();
  function dayStart(date: string) {
    const known = starts.get(date);
    if (known !== undefined) return known;
    // Search for the first instant on this date. Local midnight can use a
    // different offset from noon, or even be skipped by a clock change.
    const utc = Date.parse(date) / 1000;
    let lo = utc - 86400;
    let hi = utc + 86400;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (localDate(mid) < date) lo = mid + 1;
      else hi = mid;
    }
    starts.set(date, lo);
    return lo;
  }

  const files = new Map<string, PositionFile>();
  const days: DailyPlan['days'] = new Map();
  for (const [day, [start, end]] of windows) {
    const provenance: PositionProvenance['files'] = [];
    const first = localDate(start);
    const last = localDate(end - 1);
    for (let date = first; date <= last; date = addDays(date, 1)) {
      const partitionStart = dayStart(date);
      const partitionEnd = dayStart(addDays(date, 1));
      if (partitionStart === partitionEnd) continue;
      const object = objects.get(date);
      const handle = object?.handle ?? null;
      const windowStart = Math.max(start, partitionStart);
      const windowEnd = Math.min(end, partitionEnd);
      let file = files.get(date);
      if (file) {
        file.windowStart = Math.min(file.windowStart, windowStart);
        file.windowEnd = Math.max(file.windowEnd, windowEnd);
      } else {
        file = {date, start: partitionStart, end: partitionEnd, windowStart, windowEnd, completes: [], handle, rows: object?.rows};
        files.set(date, file);
      }
      if (date === last) file.completes.push(day);
      provenance.push({
        date, missing: !handle, sha256: handle?.sha256,
        url: handle?.kind === 'verified' ? handle.url : undefined,
        approximateRows: object?.approximateRows,
      });
    }
    days.set(day, {window: [start, end], files: provenance});
  }
  return {files: [...files.values()].sort((a, b) => a.start - b.start), days};
}

export async function sha256(bytes: Uint8Array<ArrayBuffer>) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export const MAX_POSITION_FILE_BYTES = 64 * 1024 * 1024;

/** Reads a capped response, also enforcing an exact published length when supplied. */
export async function readPositionBytes(response: Response, limit: number, exact?: number) {
  const length = response.headers.get('Content-Length');
  if (!response.body || (length !== null && Number(length) > limit)) {
    throw new Error('The position archive returned an unexpected file size.');
  }
  const reader = response.body.getReader();
  const output = new Uint8Array(exact ?? limit);
  let used = 0;
  try {
    for (;;) {
      const {value, done} = await reader.read();
      if (done) break;
      if (used + value.length > output.length) throw new Error('The position archive returned an unexpected file size.');
      output.set(value, used);
      used += value.length;
    }
    if (exact !== undefined && used !== exact) throw new Error('The position archive returned an incomplete file.');
    return output.subarray(0, used);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function verifiedPositionBytes(response: Response, bytes: number, sha: string, limit: number) {
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > limit) throw new Error('The position archive file is larger than this app reads, or has no size.');
  const data = await readPositionBytes(response, limit, bytes);
  if (await sha256(data) !== sha) throw new Error('The position archive file did not match its published checksum.');
  return data;
}
