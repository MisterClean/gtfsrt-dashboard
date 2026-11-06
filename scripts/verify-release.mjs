// Checks the built release before it ships: everything local, nothing surprising.
import {readFile, readdir, stat} from 'node:fs/promises';
import {resolve, relative, extname} from 'node:path';
import {createHash} from 'node:crypto';
import {extensions} from './extensions.mjs';

const root = resolve(import.meta.dirname, '../dist');
const html = await readFile(resolve(root, 'index.html'), 'utf8');
const pageAssets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => m[1]);
for (const path of pageAssets) {
  if (!path.startsWith('./')) throw new Error(`Non-local page asset: ${path}`);
  await stat(resolve(root, path));
}
const files = [];
async function visit(directory) {
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    if (entry.isSymbolicLink()) throw new Error('Release contains a symbolic link.');
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await visit(path);
    else files.push(path);
  }
}
await visit(root);
for (const path of files) {
  if (/(\.env|\.duckdb$|\.parquet$|\.map$|\.rs$|node_modules)/.test(relative(root, path))) throw new Error(`Unexpected runtime file: ${path}`);
  const bytes = await readFile(path);
  if (extname(path) === '.wasm' && !bytes.subarray(0, 4).equals(Buffer.from([0, 97, 115, 109]))) throw new Error(`Invalid WASM binary: ${path}`);
}
for (const extension of extensions) {
  const path = files.find(path => path.endsWith(`/engine/extensions/v2.0.0/wasm_eh/${extension.name}.duckdb_extension.wasm`));
  if (!path) throw new Error(`Missing self-hosted ${extension.name} extension.`);
  const digest = createHash('sha256').update(await readFile(path)).digest('hex');
  if (digest !== extension.sha256) throw new Error(`Release ${extension.name} integrity mismatch.`);
}
const required = [
  [/transit_wasm_bg-[\w-]+\.wasm$/, 'hashed Rust engine'],
  [/duckdb-base-[\w-]+\.wasm$/, 'DuckDB engine'],
  [/duckdb-browser-base\.worker-[\w-]+\.js$/, 'DuckDB worker'],
  [/maplibre-gl-worker-[\w-]+\.mjs$/, 'map worker'],
  [/big-shoulders-display-800\.woff2$/, 'display font'],
];
for (const [pattern, label] of required) {
  if (!files.some(path => pattern.test(path))) throw new Error(`Missing ${label}.`);
}
// No executable asset may reach for a CDN at runtime.
for (const path of files.filter(file => /\.(js|mjs|css|html)$/.test(file))) {
  const text = await readFile(path, 'utf8');
  for (const host of ['cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com', 'extensions.duckdb.org/v']) {
    if (path.includes('duckdb-browser-base.worker')) continue;
    if (text.includes(`https://${host}`)) throw new Error(`${relative(root, path)} references ${host}.`);
  }
}
const release = JSON.parse(await readFile(resolve(root, 'release.json'), 'utf8'));
if (release.engine !== 'v2.0.0' || release.wasmBindgen !== '0.2.105') throw new Error('Unexpected executable versions.');
console.log(`Verified ${files.length} release files, Rust engine, workers and pinned signed extensions. No transit working data is packaged.`);
