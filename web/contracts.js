export const ARCHIVE = 'https://storage.googleapis.com/parquet.gtfsrt.io/';
export const MAX_BYTES = 128 * 1024 * 1024;
export const MAX_METADATA_BYTES = 2 * 1024 * 1024;

export function validateArchiveURL(value) {
  const url = new URL(value);
  if (url.origin !== 'https://storage.googleapis.com' || !url.pathname.startsWith('/parquet.gtfsrt.io/') ||
      url.username || url.password || url.search || url.hash || /%2f|%5c|%2e/i.test(url.pathname)) {
    throw new Error('Only the public parquet.gtfsrt.io archive is allowed.');
  }
  return url.href;
}

export function validateManifest(files) {
  if (!Array.isArray(files) || !files.length || files.length > 6) throw new Error('Select one to six UTC days.');
  const pattern = /^https:\/\/storage\.googleapis\.com\/parquet\.gtfsrt\.io\/vehicle_positions\/date=\d{4}-\d{2}-\d{2}\/base64url=[A-Za-z0-9_-]{1,2048}\/data\.parquet$/;
  for (const [index, file] of files.entries()) {
    validateArchiveURL(file.url);
    if (!pattern.test(file.url) || file.alias !== `day_${index}.parquet`) throw new Error('Invalid archive selection.');
  }
}

export function enforceObjectBudget(files) {
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  if (!Number.isSafeInteger(total) || total > MAX_BYTES) throw new Error(`Selected objects total ${(total / 1048576).toFixed(1)} MiB. The limit is 128 MiB; choose fewer days or a smaller feed.`);
  if (!files.some(file => file.status === 'available')) throw new Error('No archive object exists for these dates. Try an earlier day. A missing file does not mean no service ran.');
  return total;
}
