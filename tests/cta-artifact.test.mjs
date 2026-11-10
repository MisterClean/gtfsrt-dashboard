import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {ARTIFACT_LIMITS, packageCtaArtifact, planBatches} from '../scripts/package-cta-artifact.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'cta-artifact-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const snapshot = join(directory, 'snapshot');
  await mkdir(join(snapshot, 'routes'), {recursive: true});
  await mkdir(join(snapshot, 'lines'));
  const dates = ['2026-11-09'];
  await writeFile(join(snapshot, 'index.json'), JSON.stringify({version: 1, requestedDates: dates, routes: [{id: '9'}], details: {'9': 'routes/9.json'}}));
  await writeFile(join(snapshot, 'routes/9.json'), JSON.stringify({route: {score: {id: '9'}, dates, directions: [{dir: 0}]}, map: {features: []}, lines: 'lines/9.json.gz'}));
  await writeFile(join(snapshot, 'lines/9.json.gz'), gzipSync(JSON.stringify({'0': {'2026-11-09': {available: true, line: null}}})));
  await writeFile(join(snapshot, 'positions.parquet'), 'raw source');

  const build = join(directory, 'build');
  await mkdir(join(build, 'assets'), {recursive: true});
  await mkdir(join(build, 'fonts'));
  await mkdir(join(build, 'engine'));
  await writeFile(join(build, 'index.html'), '<html><head><script type="module" crossorigin src="./assets/index-a.js"></script>\n<link rel="stylesheet" crossorigin href="./assets/index-a.css"></head></html>');
  await writeFile(join(build, 'assets/index-a.js'), 'const w=new URL(`maplibre-gl-worker-a.mjs`,import.meta.url).href;const s="</script>";');
  await writeFile(join(build, 'assets/index-a.css'), '@font-face{src:url(../fonts/face.woff2) format("woff2")}');
  await writeFile(join(build, 'assets/maplibre-gl-worker-a.mjs'), 'worker');
  await writeFile(join(build, 'assets/duckdb-base.wasm'), 'engine');
  await writeFile(join(build, 'fonts/face.woff2'), 'font');
  return {directory, snapshot, build, output: join(directory, 'artifact')};
}

test('stages one self-contained page, the map worker and only referenced reports', async t => {
  const {snapshot, build, output} = await fixture(t);
  await packageCtaArtifact({build, snapshot, output});
  const dist = join(output, 'dist');
  assert.deepEqual((await readdir(dist)).sort(), ['index.html', 'maplibre-gl-worker-a.mjs', 'snapshot']);
  assert.deepEqual((await readdir(join(dist, 'snapshot/lines'))), ['9.json']);
  const page = await readFile(join(dist, 'index.html'), 'utf8');
  assert.match(page, /^<title>CTA Bus Route Scorecard<\/title>/);
  assert.doesNotMatch(page, /<html|<head|<body/);
  assert.match(page, /name="transit-snapshot" content="\.\/snapshot\/index\.json"/);
  assert.match(page, /name="transit-basemap" content="off"/);
  assert.match(page, /url\("data:font\/woff2;base64,/);
  assert.match(page, /const s="<\\\/script>"/);
  assert.equal(page.match(/<\/script>/g).length, 1);
  // Gzip is not a served type: diagrams are staged as JSON and the route report follows.
  const route = JSON.parse(await readFile(join(dist, 'snapshot/routes/9.json'), 'utf8'));
  assert.equal(route.lines, 'lines/9.json');
  assert.deepEqual(JSON.parse(await readFile(join(dist, 'snapshot/lines/9.json'), 'utf8')), {'0': {'2026-11-09': {available: true, line: null}}});
  const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest.batches[0].files), ['maplibre-gl-worker-a.mjs', 'snapshot/index.json', 'snapshot/routes/9.json', 'snapshot/lines/9.json']);
  assert.equal(manifest.batches[0].files['maplibre-gl-worker-a.mjs'].contentType, 'text/javascript');
  assert.deepEqual(manifest.capabilities, {downloads: true});
});

test('splits publishes at the file and byte limits, counting the page in the first', () => {
  const entries = Array.from({length: 5}, (_, i) => ({path: `snapshot/lines/${i}.json`, bytes: 40, contentType: 'application/json'}));
  const limits = {...ARTIFACT_LIMITS, publishFiles: 3, publishBytes: 100};
  const batches = planBatches(entries, 10, limits);
  assert.deepEqual(batches.map(b => [b.count, b.bytes]), [[3, 90], [2, 80], [1, 40]]);
  assert.throws(() => planBatches(entries, 10, {...limits, versionBytes: 150}), /beyond one version's limits/);
  assert.throws(() => planBatches([{path: 'big.json', bytes: 200, contentType: 'application/json'}], 10, {...limits, textFileBytes: 100}), /file limit/);
});

test('does not overwrite a source input directory', async t => {
  const {directory, snapshot, build} = await fixture(t);
  await assert.rejects(packageCtaArtifact({build: join(directory, 'dist'), snapshot, output: directory}), /separate/);
  await assert.rejects(packageCtaArtifact({build, snapshot: join(directory, 'artifact/dist/snapshot'), output: join(directory, 'artifact')}), /separate/);
});
