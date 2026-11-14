import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {packageCtaSite, snapshotFiles} from '../scripts/package-cta-site.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'cta-package-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const snapshot = join(directory, 'snapshot');
  await mkdir(join(snapshot, 'routes'), {recursive: true});
  await mkdir(join(snapshot, 'lines'));
  const dates = ['2026-11-09'];
  await writeFile(join(snapshot, 'index.json'), JSON.stringify({version: 1, requestedDates: dates, routes: [{id: '9'}], details: {'9': 'routes/9.json'}}));
  await writeFile(join(snapshot, 'routes/9.json'), JSON.stringify({route: {score: {id: '9'}, dates, directions: [{dir: 0}]}, map: {features: []}, lines: 'lines/9.json.gz'}));
  await writeFile(join(snapshot, 'lines/9.json.gz'), gzipSync(JSON.stringify({'0': {'2026-11-09': {available: true, line: null}}})));
  return {directory, snapshot};
}

test('publishes only reports referenced by the manifest, excluding raw data and the live engine', async t => {
  const {directory, snapshot} = await fixture(t);
  await writeFile(join(snapshot, 'positions.parquet'), 'raw source');
  await writeFile(join(snapshot, 'unreferenced.json'), '{"raw":"source"}');
  const build = join(directory, 'build');
  await mkdir(join(build, 'assets'), {recursive: true});
  await mkdir(join(build, 'engine'));
  await writeFile(join(build, 'index.html'), '<html><head><title>Transit Almanac</title></head></html>');
  for (const name of ['index-a.js', 'index-a.css', 'duckdb-base.wasm', 'worker-a.js', 'maplibre-gl-worker-a.js']) {
    await writeFile(join(build, 'assets', name), 'asset');
  }
  const output = join(directory, 'site');
  await packageCtaSite({build, snapshot, output});
  assert.deepEqual(await readdir(join(output, 'dist/snapshot')), ['index.json', 'lines', 'routes']);
  assert.deepEqual(await readdir(join(output, 'dist/assets')), ['index-a.css', 'index-a.js', 'maplibre-gl-worker-a.js']);
  assert.match(await readFile(join(output, 'dist/index.html'), 'utf8'), /name="transit-snapshot" content="\.\/snapshot\/index\.json"/);
});

test('rejects traversal paths in generated report references', async t => {
  const {snapshot} = await fixture(t);
  await writeFile(join(snapshot, 'index.json'), JSON.stringify({version: 1, requestedDates: ['2026-11-09'], routes: [{id: '9'}], details: {'9': '../outside.json'}}));
  await assert.rejects(snapshotFiles(snapshot), /invalid detail path/);
});

test('rejects incomplete gzip before replacing a previously staged Site', async t => {
  const {directory, snapshot} = await fixture(t);
  const output = join(directory, 'site');
  await mkdir(join(output, 'dist'), {recursive: true});
  await writeFile(join(output, 'dist/index.html'), 'last good site');
  await writeFile(join(snapshot, 'lines/9.json.gz'), gzipSync('{}').subarray(0, 8));
  await assert.rejects(packageCtaSite({build: join(directory, 'build'), snapshot, output}), /Invalid or incomplete JSON report/);
  assert.equal(await readFile(join(output, 'dist/index.html'), 'utf8'), 'last good site');
});

test('rejects missing route dates in valid compressed JSON', async t => {
  const {snapshot} = await fixture(t);
  await writeFile(join(snapshot, 'lines/9.json.gz'), gzipSync(JSON.stringify({version: 1, distances: [], directions: {}})));
  await assert.rejects(snapshotFiles(snapshot), /Missing trip diagram result/);
});

test('does not overwrite a source input directory', async t => {
  const {directory, snapshot} = await fixture(t);
  await assert.rejects(packageCtaSite({build: join(directory, 'dist'), snapshot, output: directory}), /separate/);
});
