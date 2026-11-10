// The visitor's own results, kept in their browser so a day is only ever
// analysed once. Holds derived rollups, never raw vehicle data. Every read and write
// tolerates storage being unavailable: the app then simply re-analyses. It never does
// so silently, though: each failure is logged, and the first one is reported so the
// page can say once that results won't be kept.
// Keep the original database name so analyzed days survive the rename.
const DB_NAME = 'transit-notebook';
const STORES = ['schedules', 'days', 'events', 'feeds', 'dayIndex'] as const;
type Store = (typeof STORES)[number];

let opening: Promise<IDBDatabase | null> | undefined;
let listener: ((message: string) => void) | undefined;
let reported = false;

/** Registers who hears about cache trouble. Only the first problem is passed on. */
export function onCacheProblem(callback: (message: string) => void) {
  listener = callback;
}

function problem(operation: string, error?: unknown) {
  console.warn(`[cache] ${operation} failed; falling back to analysing without saved results`, error ?? '');
  if (reported) return;
  reported = true;
  listener?.("This browser isn't keeping saved results, perhaps because storage is blocked, full, or switched off (private windows often do this). Days will work for this visit but have to be downloaded and analyzed again next time.");
}

function open(): Promise<IDBDatabase | null> {
  opening ??= new Promise(resolve => {
    try {
      const request = indexedDB.open(DB_NAME, 2);
      request.onupgradeneeded = () => {
        for (const store of STORES) {
          if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        problem('opening the database', request.error);
        resolve(null);
      };
      request.onblocked = () => {
        problem('opening the database (blocked by another tab)');
        resolve(null);
      };
    } catch (error) {
      problem('opening the database', error);
      resolve(null);
    }
  });
  return opening;
}

function run<T>(store: Store, mode: IDBTransactionMode, action: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return open().then(db => new Promise<T | null>(resolve => {
    if (!db) return resolve(null);
    try {
      const request = action(db.transaction(store, mode).objectStore(store));
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => {
        problem(`reading ${store}`, request.error);
        resolve(null);
      };
    } catch (error) {
      problem(`reading ${store}`, error);
      resolve(null);
    }
  }));
}

export const getEntry = <T>(store: Store, key: string) => run<T>(store, 'readonly', s => s.get(key) as IDBRequest<T>);
export const deleteEntry = (store: Store, key: string) => run(store, 'readwrite', s => s.delete(key));

/** Saves an entry, and says whether it worked. Storage can be full or switched off. */
export function putEntry(store: Store, key: string, value: unknown): Promise<boolean> {
  return open().then(db => new Promise<boolean>(resolve => {
    if (!db) return resolve(false);
    try {
      const transaction = db.transaction(store, 'readwrite');
      transaction.objectStore(store).put(value, key);
      transaction.oncomplete = () => resolve(true);
      transaction.onerror = () => {
        problem(`saving to ${store}`, transaction.error);
        resolve(false);
      };
      transaction.onabort = () => {
        problem(`saving to ${store}`, transaction.error);
        resolve(false);
      };
    } catch (error) {
      problem(`saving to ${store}`, error);
      resolve(false);
    }
  }));
}

export const dayKey = (feed: string, date: number, version: number) => `${feed}|${date}|${version}`;
export const scheduleKey = (feed: string, digest: string) => `${feed}|${digest}`;

export interface DayEntry { cube: Uint8Array; digest: string; savedAt: string }
export interface EventsEntry { events: Uint8Array }
export interface ScheduleEntry { meta: Uint8Array }
/** Where a zone came from matters: a schedule's own zone always beats an estimate. */
export interface FeedEntry { timezone: string | null; estimated: boolean }
export interface DayIndexEntry { bytes: number }

/** Cached service dates for a feed and how many bytes they occupy. */
export async function listDays(feed: string, version: number) {
  const db = await open();
  const empty = {dates: [] as number[], bytes: 0};
  if (!db) return empty;
  return new Promise<{dates: number[]; bytes: number}>(resolve => {
    const dates: number[] = [];
    let bytes = 0;
    try {
      const prefix = `${feed}|`;
      const range = IDBKeyRange.bound(prefix, `${prefix}\uffff`);
      const cursor = db.transaction('dayIndex').objectStore('dayIndex').openCursor(range);
      cursor.onsuccess = () => {
        const current = cursor.result;
        if (!current) return resolve({dates: dates.sort((a, b) => a - b), bytes});
        const [, date, entryVersion] = String(current.key).split('|');
        if (Number(entryVersion) === version) {
          dates.push(Number(date));
          bytes += (current.value as DayIndexEntry | undefined)?.bytes ?? 0;
        }
        current.continue();
      };
      cursor.onerror = () => {
        problem('listing saved days', cursor.error);
        resolve({dates, bytes});
      };
    } catch (error) {
      problem('listing saved days', error);
      resolve(empty);
    }
  });
}

/** Removes everything stored for one feed, or for all feeds. Rejects if it can't. */
export async function clearCache(feed?: string) {
  const db = await open();
  if (!db) return;
  await Promise.all(STORES.map(store => new Promise<void>((resolve, reject) => {
    try {
      const transaction = db.transaction(store, 'readwrite');
      const objects = transaction.objectStore(store);
      if (!feed) objects.clear();
      else if (store === 'feeds') objects.delete(feed);
      else objects.delete(IDBKeyRange.bound(`${feed}|`, `${feed}|\uffff`));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(new Error('Your browser could not clear its saved results.'));
      transaction.onabort = () => reject(new Error('Your browser could not clear its saved results.'));
    } catch {
      reject(new Error('Your browser could not clear its saved results.'));
    }
  })));
}
