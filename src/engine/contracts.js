// Network rules for transit data. Kept small and dependency-free so it can be
// tested directly and read at a glance.
export const ARCHIVE = 'https://storage.googleapis.com/parquet.gtfsrt.io/';
export const DEFAULT_ARCHIVE_ID = 'gtfsrt-io';
export const MAX_METADATA_BYTES = 8 * 1024 * 1024;
/** Largest single schedule table we will read. Bounds a bad catalog entry. */
export const MAX_SCHEDULE_TABLE_BYTES = 64 * 1024 * 1024;
/** Largest single daily object. The biggest feed today is about 190 MB. */
export const MAX_OBJECT_BYTES = 600 * 1024 * 1024;

/** App configuration supplies the root. Catalogs may only name relative object keys. */
export function archiveObjectURL(root, path) {
  if (!/^[A-Za-z0-9_=.:-]+(?:\/[A-Za-z0-9_=.:-]+)*$/.test(path) || path.split('/').some(part => part === '.' || part === '..')) {
    throw new Error('Invalid archive object path.');
  }
  return new URL(root + path).href;
}

export function enforceObjectSize(bytes, label) {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error(`The size of ${label} is unavailable.`);
  if (bytes > MAX_OBJECT_BYTES) throw new Error(`${label} is ${(bytes / 1048576).toFixed(0)} MiB, more than the ${MAX_OBJECT_BYTES / 1048576} MiB this app reads from one object.`);
  return bytes;
}
