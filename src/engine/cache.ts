// The visitor's own results, kept in their browser so a day is only ever
// analysed once. Holds derived rollups, never raw vehicle data. Every operation
// tolerates storage being unavailable: the app then simply re-analyses.
const DB_NAME = 'transit-notebook';
const STORES = ['schedules', 'days', 'events', 'feeds'] as const;
type Store = (typeof STORES)[number];

let opening: Promise<IDBDatabase | null> | undefined;

function open(): Promise<IDBDatabase | null> {
  opening ??= new Promise(resolve => {
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        for (const store of STORES) {
          if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
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
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  }));
}

export const getEntry = <T>(store: Store, key: string) => run<T>(store, 'readonly', s => s.get(key) as IDBRequest<T>);
export const putEntry = (store: Store, key: string, value: unknown) => run(store, 'readwrite', s => s.put(value, key));
export const deleteEntry = (store: Store, key: string) => run(store, 'readwrite', s => s.delete(key));

export const dayKey = (feed: string, date: number, version: number) => `${feed}|${date}|${version}`;
export const scheduleKey = (feed: string, digest: string) => `${feed}|${digest}`;

export interface DayEntry { cube: Uint8Array; digest: string; savedAt: string }
export interface EventsEntry { events: Uint8Array }
export interface ScheduleEntry { meta: Uint8Array }
export interface FeedEntry { timezone: string | null }

/** Cached service dates for a feed and how many bytes they occupy. */
export async function listDays(feed: string, version: number) {
  const db = await open();
  if (!db) return {dates: [] as number[], bytes: 0};
  return new Promise<{dates: number[]; bytes: number}>(resolve => {
    const dates: number[] = [];
    let bytes = 0;
    try {
      const prefix = `${feed}|`;
      const range = IDBKeyRange.bound(prefix, `${prefix}￿`);
      const cursor = db.transaction('days').objectStore('days').openCursor(range);
      cursor.onsuccess = () => {
        const current = cursor.result;
        if (!current) return resolve({dates: dates.sort((a, b) => a - b), bytes});
        const [, date, entryVersion] = String(current.key).split('|');
        if (Number(entryVersion) === version) {
          dates.push(Number(date));
          bytes += (current.value as DayEntry).cube.byteLength;
        }
        current.continue();
      };
      cursor.onerror = () => resolve({dates, bytes});
    } catch {
      resolve({dates, bytes});
    }
  });
}

/** Removes everything stored for one feed, or for all feeds. */
export async function clearCache(feed?: string) {
  const db = await open();
  if (!db) return;
  await Promise.all(STORES.map(store => new Promise<void>(resolve => {
    try {
      const objects = db.transaction(store, 'readwrite').objectStore(store);
      if (!feed) {
        objects.clear().onsuccess = () => resolve();
        return;
      }
      const prefix = store === 'feeds' ? feed : `${feed}|`;
      objects.delete(IDBKeyRange.bound(prefix, `${prefix}￿`)).onsuccess = () => resolve();
    } catch {
      resolve();
    }
  })));
}
