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

// Check the toolchain first, so a missing piece produces a fix instead of a compiler error.
const WASM_BINDGEN_VERSION = '0.2.105';
const TARGET = 'wasm32-unknown-unknown';
const cargo = process.env.CARGO ?? 'cargo';
const wasmBindgen = process.env.WASM_BINDGEN ?? 'wasm-bindgen';
const capture = (command, args) => {
  const result = spawnSync(command, args, {cwd: root, encoding: 'utf8', env: process.env});
  return result.error || result.status !== 0 ? null : result.stdout.trim();
};

function preflight() {
  const problems = [];
  if (capture(cargo, ['--version']) === null) {
    problems.push(['cargo was not found.', ['curl --proto \'=https\' --tlsv1.2 -sSf https://sh.rustup.rs | sh']]);
  } else {
    const rustup = capture('rustup', ['--version']);
    if (rustup === null) {
      problems.push([
        `The Rust on your PATH is not managed by rustup (cargo: ${capture('which', ['cargo']) ?? cargo}). rust-toolchain.toml, which pins the version and the ${TARGET} target, only works with rustup. Install rustup, remove or deprioritize the other Rust (for example "brew uninstall rust"), and open a new shell.`,
        ['curl --proto \'=https\' --tlsv1.2 -sSf https://sh.rustup.rs | sh'],
      ]);
    } else {
      const installed = capture('rustup', ['target', 'list', '--installed']) ?? '';
      if (!installed.split('\n').includes(TARGET)) {
        problems.push([`The ${TARGET} target is not installed for the pinned toolchain.`, [`rustup target add ${TARGET}`]]);
      }
    }
  }
  const version = capture(wasmBindgen, ['--version']);
  if (version === null) {
    problems.push(['wasm-bindgen was not found.', [`cargo install wasm-bindgen-cli --version ${WASM_BINDGEN_VERSION} --locked`]]);
  } else if (version !== `wasm-bindgen ${WASM_BINDGEN_VERSION}`) {
    problems.push([
      `wasm-bindgen must be exactly ${WASM_BINDGEN_VERSION} to match the crate in Cargo.lock, and found "${version}".`,
      [`cargo install wasm-bindgen-cli --version ${WASM_BINDGEN_VERSION} --locked --force`],
    ]);
  }
  if (problems.length === 0) return;
  console.error('The build cannot start because the Rust toolchain is not ready:\n');
  for (const [message, fixes] of problems) {
    console.error(`- ${message}`);
    for (const fix of fixes) console.error(`    ${fix}`);
  }
  console.error('\nSee CONTRIBUTING.md for the full setup.');
  process.exit(1);
}
preflight();

run(cargo, ['build', '--locked', '--release', '-p', 'transit-wasm', '--target', 'wasm32-unknown-unknown']);
await mkdir(resolve(root, '.build/pkg'), {recursive: true});
run(wasmBindgen, [
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
