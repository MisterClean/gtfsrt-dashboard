// Stage only the dashboard and the explicitly referenced, derived CTA reports.
// Raw Positions files, GTFS ZIPs, and working databases never enter this directory.
import {cp, lstat, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {dirname, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gunzipSync} from 'node:zlib';

const root = resolve(import.meta.dirname, '..');
const MAX_ASSET_BYTES = 25 * 1024 * 1024;
const DETAIL_PATH = /^routes\/[A-Za-z0-9_-]+\.json$/;
const LINES_PATH = /^lines\/[A-Za-z0-9_-]+\.json\.gz$/;

function contained(parent, child) {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep));
}

async function readReport(directory, path) {
  const filename = resolve(directory, path);
  if (!contained(directory, filename)) throw new Error(`Report escapes the snapshot directory: ${path}`);
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Report must be a regular file: ${path}`);
  if (info.size > MAX_ASSET_BYTES) throw new Error(`Report exceeds the 25 MiB asset limit: ${path}`);
  const bytes = await readFile(filename);
  try {
    const json = path.endsWith('.gz') ? gunzipSync(bytes, {maxOutputLength: 256 * 1024 * 1024}) : bytes;
    return JSON.parse(json.toString('utf8'));
  } catch (cause) {
    throw new Error(`Invalid or incomplete JSON report: ${path}`, {cause});
  }
}

function validateLines(data, report, dates, id) {
  const packed = data?.version === 1;
  const directions = packed ? data.directions : data;
  if (!directions || (packed && (!Array.isArray(data.distances) || !data.distances.every(Number.isFinite)))) {
    throw new Error(`Invalid trip diagram report for route ${id}`);
  }
  for (const {dir} of report.route.directions) {
    for (const date of dates) {
      const result = directions[String(dir)]?.[date];
      if (!result || typeof result.available !== 'boolean' || !Object.hasOwn(result, 'line')) {
        throw new Error(`Missing trip diagram result for route ${id}, direction ${dir}, date ${date}`);
      }
      const {line} = result;
      if (line !== null && (!line || line.route !== id || line.dir !== dir || line.date !== date || !Array.isArray(line.trips))) {
        throw new Error(`Mismatched trip diagram result for route ${id}, direction ${dir}, date ${date}`);
      }
    }
  }
}

/** The manifest is the only authority for which generated reports are published. */
export async function snapshotFiles(directory) {
  const index = await readReport(directory, 'index.json');
  if (index.version !== 1 || !Array.isArray(index.routes) || !index.details || typeof index.details !== 'object' ||
    !Array.isArray(index.requestedDates) || !index.requestedDates.length) {
    throw new Error('Expected a version 1 CTA snapshot with routes and detail paths.');
  }
  const files = new Set(['index.json']);
  for (const route of index.routes) {
    const path = index.details[route.id];
    if (typeof path !== 'string' || !DETAIL_PATH.test(path)) throw new Error(`Missing or invalid detail path for route ${route.id}`);
    const report = await readReport(directory, path);
    if (report.route?.score?.id !== route.id || !Array.isArray(report.route.directions) ||
      JSON.stringify(report.route.dates) !== JSON.stringify(index.requestedDates) || !Array.isArray(report.map?.features)) {
      throw new Error(`Mismatched or incomplete detail report for route ${route.id}`);
    }
    files.add(path);
    if (report.lines !== undefined) {
      if (typeof report.lines !== 'string' || !LINES_PATH.test(report.lines)) throw new Error(`Invalid trip diagram path for route ${route.id}`);
      validateLines(await readReport(directory, report.lines), report, index.requestedDates, route.id);
      files.add(report.lines);
    }
  }
  return [...files].sort();
}

async function checkAssets(directory) {
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const filename = resolve(directory, entry.name);
    if (entry.isDirectory()) await checkAssets(filename);
    else if (!entry.isFile() || (await lstat(filename)).size > MAX_ASSET_BYTES) {
      throw new Error(`Site assets must be regular files smaller than 25 MiB: ${filename}`);
    }
  }
}

export async function packageCtaSite({build = resolve(root, 'dist'), snapshot = resolve(root, '.cache/cta/snapshot'), output = resolve(root, '.cache/cta/site')} = {}) {
  build = resolve(build);
  snapshot = resolve(snapshot);
  output = resolve(output);
  const destination = resolve(output, 'dist');
  // The ignored cache inside the repository is a valid destination. Neither
  // input, nor the repository itself, may be removed by replacing its dist/.
  if (contained(destination, root) || [build, snapshot].some(input => contained(destination, input) || contained(input, destination))) {
    throw new Error('The Site output must be separate from the build and snapshot inputs.');
  }
  const files = await snapshotFiles(snapshot);
  await readFile(resolve(build, 'index.html'), 'utf8');
  await mkdir(output, {recursive: true});
  await rm(destination, {recursive: true, force: true});
  await cp(build, destination, {recursive: true, filter: source => {
    const path = relative(build, source).split(sep).join('/');
    return !/^(?:engine|snapshot)(?:\/|$)/.test(path)
      && !/^assets\/(?:duckdb-|transit_wasm|worker-)/.test(path)
      && !/\.(?:parquet|zip|csv|duckdb|sqlite|wasm)(?:\.|$)/i.test(path);
  }});
  for (const path of files) {
    const target = resolve(destination, 'snapshot', path);
    await mkdir(dirname(target), {recursive: true});
    await cp(resolve(snapshot, path), target);
  }
  const indexPath = resolve(destination, 'index.html');
  let html = await readFile(indexPath, 'utf8');
  html = html.replace(/<title>.*?<\/title>/s, '<title>CTA Bus Route Scorecard</title>')
    .replace(/<meta name="description" content="[^"]*"\s*\/>/, '<meta name="description" content="CTA bus route performance over the last 20 completed weekdays, with detailed speeds, reliability, and data coverage." />')
    .replace('</head>', '  <meta name="transit-snapshot" content="./snapshot/index.json" />\n  </head>')
    .replace(/(<p id="boot-status" role="status">)[^<]*(<\/p>)/, '$1Loading the CTA bus snapshot…$2')
    .replace('This dashboard runs in your browser and needs JavaScript and WebAssembly.', 'This dashboard needs JavaScript to display the precomputed CTA reports.');
  await writeFile(indexPath, html);
  await checkAssets(destination);
  await writeFile(resolve(output, 'README.md'), '# CTA Bus Route Scorecard\n\nGenerated static Site from Transit Almanac. `dist/` contains the application and derived CTA reports only. Raw Positions files, GTFS ZIPs, databases, and processing caches are excluded. Rebuild with `npm run build` followed by `npm run package:cta-site` in the integration repository.\n');
  return {directory: destination, reports: files.length};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {};
  const names = {'--build': 'build', '--snapshot': 'snapshot', '--output': 'output'};
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = names[process.argv[index]];
    if (!key || !process.argv[index + 1]) throw new Error('Usage: node scripts/package-cta-site.mjs [--build DIR] [--snapshot DIR] [--output DIR]');
    options[key] = process.argv[index + 1];
  }
  console.log(JSON.stringify(await packageCtaSite(options)));
}
