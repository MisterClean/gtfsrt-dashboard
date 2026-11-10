// Probes the public archive inventory and writes public/feed-health.json.
//
//   node scripts/validate-feeds.mjs            probe, then write the file
//   node scripts/validate-feeds.mjs --offline  skip the HEAD requests (inventory only)
//
// Per feed it records the status, the latest complete day, about how many bytes
// a day weighs, and whether the newest object answers a HEAD request. Trip-ID
// match and trips a day cannot be derived without reading parquet and a
// schedule, so they come from src/data/feed-overrides.json when someone has
// measured them. Overrides beat everything the probe derives.
import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {ARCHIVE} from '../src/engine/contracts.js';
import {addIsoDays, feedId, findOverride, resolveHealth, sizeClass} from '../src/lib/health.ts';

const root = resolve(import.meta.dirname, '..');
const outPath = resolve(root, 'public/feed-health.json');
const overridesPath = resolve(root, 'src/data/feed-overrides.json');
const args = new Set(process.argv.slice(2));

/** HEAD on the newest complete day's object. Null when the probe could not tell. */
export async function headObject(feed, fetchImpl = fetch) {
  const day = addIsoDays(feed.date_max, -1);
  const url = `${ARCHIVE}vehicle_positions/date=${day}/base64url=${feed.base64url}/data.parquet`;
  try {
    const response = await fetchImpl(url, {method: 'HEAD', signal: AbortSignal.timeout(15000)});
    if (response.status === 404) return {head_ok: false, bytes: null};
    if (!response.ok) return {head_ok: null, bytes: null};
    const bytes = Number(response.headers.get('content-length'));
    return {head_ok: true, bytes: Number.isFinite(bytes) && bytes > 0 ? bytes : null};
  } catch {
    return {head_ok: null, bytes: null};
  }
}

export async function buildHealthFile({inventory, overrides, probe}) {
  const feeds = inventory.filter(f => f.feed_type === 'vehicle_positions' && /^[A-Za-z0-9_-]+$/.test(f.base64url));
  if (!feeds.length) throw new Error('The inventory lists no vehicle-position feeds.');
  const reference = feeds.map(f => f.date_max).sort().at(-1);
  const out = {};
  for (const feed of feeds) {
    const measured = probe ? await probe(feed) : {head_ok: null};
    const health = resolveHealth({
      facts: feed, reference, override: findOverride(overrides, feed), measured,
    });
    // A missing newest object is worse than the averages suggest.
    if (measured.head_ok === false && health.status === 'ok') {
      health.status = 'stale';
      health.reason = 'The newest archive file is missing';
    }
    // A single file's size beats the lifetime average when we have it.
    if (measured.bytes) health.approx_bytes_per_day = sizeClass(measured.bytes);
    out[feed.base64url] = {id: feedId(feed), name: feed.agency_name, ...health};
  }
  return {schema: 1, feeds: out};
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const response = await fetch(`${ARCHIVE}inventory.json`, {signal: AbortSignal.timeout(30000)});
  if (!response.ok) throw new Error(`inventory.json answered HTTP ${response.status}`);
  const inventory = await response.json();
  const overrides = JSON.parse(await readFile(overridesPath, 'utf8'));
  delete overrides._help;
  const probe = args.has('--offline') ? null : async feed => ({...(await headObject(feed))});
  const next = await buildHealthFile({inventory, overrides, probe});
  await writeFile(outPath, `${JSON.stringify(next, null, 2)}\n`);
  const counts = {};
  for (const h of Object.values(next.feeds)) counts[h.status] = (counts[h.status] ?? 0) + 1;
  console.log(`Wrote ${outPath}`, counts);
}
