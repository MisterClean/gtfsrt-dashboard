import {build} from 'esbuild';
import {mkdir, readFile, writeFile, cp, rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {prepareExtensions, extensions} from './extensions.mjs';

const root = resolve(import.meta.dirname, '..');
const run = (command, args) => {
  const result = spawnSync(command, args, {cwd: root, stdio: 'inherit', env: process.env});
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};
const hash = data => createHash('sha256').update(data).digest('hex').slice(0, 16);
const extensionDirectory = await prepareExtensions(root);
await mkdir(resolve(root, '.build/pkg'), {recursive: true});
if (!process.argv.includes('--assets-only')) {
  run(process.env.CARGO ?? 'cargo', ['build', '--locked', '--release', '--target', 'wasm32-unknown-unknown']);
  run(process.env.WASM_BINDGEN ?? 'wasm-bindgen', [resolve(root, 'target/wasm32-unknown-unknown/release/gtfsrt_dashboard.wasm'), '--target', 'web', '--out-dir', resolve(root, '.build/pkg')]);
}
// Build separately, then rename the completed directory. Every executable dependency is local.
const outdir = resolve(root, '.build/release');
await rm(outdir, {recursive: true, force: true});
await mkdir(resolve(outdir, 'assets'), {recursive: true});
const duck = resolve(root, 'node_modules/@duckdb/duckdb-wasm/dist');
const engineHash = hash(await readFile(resolve(duck, 'duckdb-base.wasm')));
const duckDirectory = `duckdb-${engineHash}`;
await mkdir(resolve(outdir, 'assets', duckDirectory));
for (const name of ['duckdb-base.wasm', 'duckdb-browser-base.worker.js']) await cp(resolve(duck, name), resolve(outdir, 'assets', duckDirectory, name));
const extensionOutput = resolve(outdir, 'assets', duckDirectory, 'extensions/v2.0.0/wasm_eh');
await mkdir(extensionOutput, {recursive: true});
for (const {name} of extensions) await cp(resolve(extensionDirectory, `${name}.duckdb_extension.wasm`), resolve(extensionOutput, `${name}.duckdb_extension.wasm`));
const result = await build({entryPoints: [resolve(root, 'web/bootstrap.js')], bundle: true, minify: true,
  format: 'esm', target: 'es2022', outdir, entryNames: 'assets/app-[hash]', assetNames: 'assets/[name]-[hash]',
  loader: {'.wasm': 'file'}, metafile: true, alias: {'gtfsrt-contracts': resolve(root, 'web/contracts.js')},
  define: {__DUCKDB_BASE_PATH__: JSON.stringify(`./${duckDirectory}/`)}, logLevel: 'warning'});
const script = Object.entries(result.metafile.outputs).find(([, value]) => value.entryPoint)?.[0];
if (!script) throw new Error('Build produced no application entry point.');
const style = await readFile(resolve(root, 'web/styles.css'));
const styleName = `assets/styles-${hash(style)}.css`;
await writeFile(resolve(outdir, styleName), style);
await cp(resolve(root, 'web/fonts'), resolve(outdir, 'assets/fonts'), {recursive: true});
await cp(resolve(root, 'web/licenses'), resolve(outdir, 'licenses'), {recursive: true});
await cp(resolve(root, 'web/favicon.svg'), resolve(outdir, 'favicon.svg'));
let html = await readFile(resolve(root, 'web/index.html'), 'utf8');
html = html.replace('__STYLE__', `./${styleName}`).replace('__SCRIPT__', `./${script.slice(script.indexOf('assets/'))}`);
await writeFile(resolve(outdir, 'index.html'), html);
await writeFile(resolve(outdir, 'release.json'), JSON.stringify({app: '0.1.0', metric: 'archive-observations-v1', engine: 'v2.0.0', wrapper: '1.33.1-dev114.0', wasmBindgen: '0.2.105', builtAt: new Date().toISOString()}, null, 2));
await rm(resolve(root, 'dist'), {recursive: true, force: true});
await cp(outdir, resolve(root, 'dist'), {recursive: true});
console.log('Built self-contained static release in dist/');
