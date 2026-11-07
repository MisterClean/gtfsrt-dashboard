// Network rules for transit data. Kept small and dependency-free so it can be
// tested directly and read at a glance.
export const ARCHIVE = 'https://storage.googleapis.com/parquet.gtfsrt.io/';
export const MAX_METADATA_BYTES = 8 * 1024 * 1024;
/** Largest single schedule table we will read. Bounds a bad catalog entry. */
export const MAX_SCHEDULE_TABLE_BYTES = 64 * 1024 * 1024;
/** Largest single daily object. The biggest feed today is about 190 MB. */
export const MAX_OBJECT_BYTES = 600 * 1024 * 1024;

export function validateArchiveURL(value) {
  const url = new URL(value);
  if (url.origin !== 'https://storage.googleapis.com' || !url.pathname.startsWith('/parquet.gtfsrt.io/') ||
      url.username || url.password || url.search || url.hash || /%2f|%5c|%2e/i.test(url.pathname)) {
    throw new Error('Only the public parquet.gtfsrt.io archive is allowed.');
  }
  return url.href;
}

export function enforceObjectSize(bytes, label) {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error(`The size of ${label} is unavailable.`);
  if (bytes > MAX_OBJECT_BYTES) throw new Error(`${label} is ${(bytes / 1048576).toFixed(0)} MiB, more than the ${MAX_OBJECT_BYTES / 1048576} MiB this app reads from one object.`);
  return bytes;
}
