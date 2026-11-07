// Compiles the Rust engine, gathers the pinned DuckDB extensions, then bundles.
// `--wasm-only` stops before the bundle, for use with the Vite dev server.
import {cp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {prepareExtensions, extensions} from './extensions.mjs';

const root = resolve(import.meta.dirname, '..');
const run = (command, args) => {
  const result = spawnSync(command, args, {cwd: root, stdio: 'inherit', env: process.env});
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};

run(process.env.CARGO ?? 'cargo', ['build', '--locked', '--release', '-p', 'transit-wasm', '--target', 'wasm32-unknown-unknown']);
await mkdir(resolve(root, '.build/pkg'), {recursive: true});
run(process.env.WASM_BINDGEN ?? 'wasm-bindgen', [
  resolve(root, 'target/wasm32-unknown-unknown/release/transit_wasm.wasm'),
  '--target', 'web', '--out-dir', resolve(root, '.build/pkg'),
]);

// DuckDB only loads extensions from the release itself. See docs/packaging-security.md.
const source = await prepareExtensions(root);
const target = resolve(root, 'public/engine/extensions/v2.0.0/wasm_eh');
await rm(resolve(root, 'public/engine'), {recursive: true, force: true});
await mkdir(target, {recursive: true});
for (const {name} of extensions) {
  await cp(resolve(source, `${name}.duckdb_extension.wasm`), resolve(target, `${name}.duckdb_extension.wasm`));
}

if (!process.argv.includes('--wasm-only')) {
  run(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), 'build', '--logLevel', 'warn']);
  const cube = await readFile(resolve(root, 'crates/core/src/cube.rs'), 'utf8');
  const metric = Number(cube.match(/METRIC_VERSION: u32 = (\d+)/)?.[1]);
  await writeFile(resolve(root, 'dist/release.json'), JSON.stringify({
    app: '0.2.0', metric, engine: 'v2.0.0', wrapper: '1.33.1-dev114.0', wasmBindgen: '0.2.105', builtAt: new Date().toISOString(),
  }, null, 2));
  console.log('Built self-contained static release in dist/');
}
