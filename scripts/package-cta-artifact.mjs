// Stage the CTA snapshot as a Claude artifact: one self-contained page plus the
// derived reports it fetches, split into publish batches that fit the Artifact
// tool's limits. Raw Positions files, GTFS ZIPs, and working databases never enter it.
import {cp, lstat, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {basename, dirname, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gunzipSync} from 'node:zlib';
import {snapshotFiles} from './package-cta-site.mjs';

const root = resolve(import.meta.dirname, '..');
const MB = 1000 * 1000;

/** The Artifact tool's documented limits, with a margin on bytes per publish. */
export const ARTIFACT_LIMITS = {
  pageBytes: 16 * MB,
  textFileBytes: 16 * MB,
  binaryFileBytes: 15 * MB,
  publishFiles: 255,
  publishBytes: 60 * MB,
  versionFiles: 511,
  versionBytes: 256 * MB,
};

const CONTENT_TYPES = {'.json': 'application/json', '.mjs': 'text/javascript', '.js': 'text/javascript'};

function contained(parent, child) {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep));
}

function contentType(path) {
  const type = CONTENT_TYPES[path.slice(path.lastIndexOf('.'))];
  if (!type) throw new Error(`No artifact content type for ${path}`);
  return type;
}

/** The built entry page names its script and stylesheet. */
async function entryAssets(build) {
  const html = await readFile(resolve(build, 'index.html'), 'utf8');
  const script = html.match(/<script type="module"[^>]*\ssrc="\.\/(assets\/[^"]+\.js)"/)?.[1];
  const style = html.match(/<link rel="stylesheet"[^>]*\shref="\.\/(assets\/[^"]+\.css)"/)?.[1];
  if (!script || !style) throw new Error('The build entry page must reference one module script and one stylesheet.');
  return {script, style};
}

/** Inline the stylesheet, with its fonts as data URIs, since the page cannot load its own CSS files. */
async function inlineStyle(build, path) {
  const css = await readFile(resolve(build, path), 'utf8');
  const fonts = [...css.matchAll(/url\(["']?(\.\.\/fonts\/[^"')]+\.woff2)["']?\)/g)];
  let result = css;
  for (const [match, font] of fonts) {
    const bytes = await readFile(resolve(build, 'assets', font));
    result = result.replace(match, `url("data:font/woff2;base64,${bytes.toString('base64')}")`);
  }
  if (/url\((?!["']?data:)/.test(result)) throw new Error('The stylesheet refers to a file the artifact page cannot load.');
  if (/<\/style/i.test(result)) throw new Error('The stylesheet cannot be inlined: it contains a closing style tag.');
  return result;
}

/** Inline the module. Relative URLs in it (the map worker) resolve against the page. */
async function inlineScript(build, path) {
  const js = await readFile(resolve(build, path), 'utf8');
  if (/<script/i.test(js)) throw new Error('The script cannot be inlined: it contains an opening script tag.');
  const workers = [...new Set([...js.matchAll(/new URL\(`(maplibre-gl-worker-[\w-]+\.mjs)`,import\.meta\.url\)/g)].map(match => match[1]))];
  if (workers.length !== 1) throw new Error('Expected one MapLibre worker reference in the bundle.');
  return {js: js.replace(/<\/script/gi, '<\\/script'), worker: workers[0]};
}

function page(css, js) {
  // The Artifact tool wraps this in its own document skeleton, so it carries no
  // <html>, <head> or <body>. The app finds its meta tags anywhere in the document.
  return `<title>CTA Bus Route Scorecard</title>
<meta name="description" content="CTA bus route performance over the last 20 completed weekdays, with detailed speeds, reliability, and data coverage.">
<meta name="transit-snapshot" content="./snapshot/index.json">
<meta name="transit-basemap" content="off">
<style>
${css}
</style>
<div id="app"><p id="boot-status" role="status">Loading the CTA bus snapshot…</p></div>
<noscript><p>This dashboard needs JavaScript to display the precomputed CTA reports.</p></noscript>
<script type="module">
${js}
</script>
`;
}

/** Greedy batches in a stable order: the index and route reports first, so the scorecard works after one publish. */
export function planBatches(entries, pageBytes, limits = ARTIFACT_LIMITS) {
  const total = entries.reduce((sum, entry) => sum + entry.bytes, pageBytes);
  if (pageBytes > limits.pageBytes) throw new Error('The artifact page exceeds 16 MB.');
  if (entries.length + 1 > limits.versionFiles || total > limits.versionBytes) {
    throw new Error(`The artifact needs ${entries.length + 1} files and ${total} bytes, beyond one version's limits.`);
  }
  const batches = [];
  // The first publish also sends the page itself.
  let current = {files: {}, count: 1, bytes: pageBytes};
  for (const entry of entries) {
    const max = entry.contentType.startsWith('text/') || entry.contentType === 'application/json' ? limits.textFileBytes : limits.binaryFileBytes;
    if (entry.bytes > max) throw new Error(`${entry.path} exceeds the artifact file limit.`);
    if (current.count + 1 > limits.publishFiles || current.bytes + entry.bytes > limits.publishBytes) {
      batches.push(current);
      current = {files: {}, count: 0, bytes: 0};
    }
    current.files[entry.path] = {from: entry.path, contentType: entry.contentType};
    current.count += 1;
    current.bytes += entry.bytes;
  }
  batches.push(current);
  return batches;
}

export async function packageCtaArtifact({build = resolve(root, 'dist'), snapshot = resolve(root, '.cache/cta/snapshot'), output = resolve(root, '.cache/cta/artifact'), limits = ARTIFACT_LIMITS} = {}) {
  build = resolve(build);
  snapshot = resolve(snapshot);
  output = resolve(output);
  const destination = resolve(output, 'dist');
  if (contained(destination, root) || [build, snapshot].some(input => contained(destination, input) || contained(input, destination))) {
    throw new Error('The artifact output must be separate from the build and snapshot inputs.');
  }
  const reports = await snapshotFiles(snapshot);
  const {script, style} = await entryAssets(build);
  const css = await inlineStyle(build, style);
  const {js, worker} = await inlineScript(build, script);
  const html = page(css, js);

  await mkdir(output, {recursive: true});
  await rm(destination, {recursive: true, force: true});
  await mkdir(destination, {recursive: true});
  await writeFile(resolve(destination, 'index.html'), html);
  // The inline module's import.meta.url is the page, so the worker sits beside it.
  await cp(resolve(build, dirname(script), worker), resolve(destination, worker));
  const entries = [{path: worker}];
  // Trip diagram companions last: every route report then arrives with the first publish.
  const rank = path => (path === 'index.json' ? 0 : path.startsWith('routes/') ? 1 : 2);
  for (const path of reports.toSorted((a, b) => rank(a) - rank(b) || a.localeCompare(b))) {
    // Artifacts do not serve gzip files, so trip diagrams are staged decompressed
    // and route reports point at the .json name. The host compresses in transit.
    const staged = path.replace(/\.json\.gz$/, '.json');
    const target = resolve(destination, 'snapshot', staged);
    await mkdir(dirname(target), {recursive: true});
    const bytes = await readFile(resolve(snapshot, path));
    if (path !== staged) await writeFile(target, gunzipSync(bytes, {maxOutputLength: limits.textFileBytes}));
    else if (path.startsWith('routes/')) {
      const report = JSON.parse(bytes.toString('utf8'));
      if (typeof report.lines === 'string') report.lines = report.lines.replace(/\.json\.gz$/, '.json');
      await writeFile(target, JSON.stringify(report));
    } else await writeFile(target, bytes);
    entries.push({path: `snapshot/${staged}`});
  }
  for (const entry of entries) {
    const info = await lstat(resolve(destination, entry.path));
    if (!info.isFile()) throw new Error(`Artifact files must be regular files: ${entry.path}`);
    entry.bytes = info.size;
    entry.contentType = contentType(entry.path);
  }
  const pageBytes = Buffer.byteLength(html);
  const batches = planBatches(entries, pageBytes, limits);
  const manifest = {
    title: 'CTA Bus Route Scorecard',
    icon: 'bus',
    // CSV buttons save through the viewer's confirmation; the frame cannot download.
    capabilities: {downloads: true},
    root: destination,
    page: 'index.html',
    files: entries.length + 1,
    bytes: entries.reduce((sum, entry) => sum + entry.bytes, pageBytes),
    batches,
  };
  await writeFile(resolve(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return {directory: destination, manifest: resolve(output, 'manifest.json'), files: manifest.files, bytes: manifest.bytes, batches: batches.length, worker: basename(worker)};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {};
  const names = {'--build': 'build', '--snapshot': 'snapshot', '--output': 'output'};
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = names[process.argv[index]];
    if (!key || !process.argv[index + 1]) throw new Error('Usage: node scripts/package-cta-artifact.mjs [--build DIR] [--snapshot DIR] [--output DIR]');
    options[key] = process.argv[index + 1];
  }
  console.log(JSON.stringify(await packageCtaArtifact(options)));
}
