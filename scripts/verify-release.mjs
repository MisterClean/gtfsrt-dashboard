import {readFile, readdir, stat} from 'node:fs/promises';
import {resolve, relative, extname} from 'node:path';
import {createHash} from 'node:crypto';
import {extensions} from './extensions.mjs';

const root = resolve(import.meta.dirname, '../dist');
const html = await readFile(resolve(root, 'index.html'), 'utf8');
if (/__(STYLE|SCRIPT)__/.test(html)) throw new Error('Unresolved HTML build placeholders.');
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
  const path = files.find(path => path.endsWith(`/extensions/v2.0.0/wasm_eh/${extension.name}.duckdb_extension.wasm`));
  if (!path) throw new Error(`Missing self-hosted ${extension.name} extension.`);
  const digest = createHash('sha256').update(await readFile(path)).digest('hex');
  if (digest !== extension.sha256) throw new Error(`Release ${extension.name} integrity mismatch.`);
}
if (!files.some(path => /gtfsrt_dashboard_bg-[A-Z0-9]+\.wasm$/.test(path))) throw new Error('Missing hashed Rust WASM asset.');
if (!files.some(path => path.endsWith('/duckdb-browser-base.worker.js'))) throw new Error('Missing DuckDB worker.');
const release = JSON.parse(await readFile(resolve(root, 'release.json'), 'utf8'));
if (release.engine !== 'v2.0.0' || release.wasmBindgen !== '0.2.105') throw new Error('Unexpected executable versions.');
console.log(`Verified ${files.length} release files, Rust WASM, worker, and pinned signed extensions. No transit working data is packaged.`);
