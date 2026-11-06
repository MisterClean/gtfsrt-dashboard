import {createServer} from 'node:http';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {resolve, extname, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {build} from 'esbuild';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const path = resolve(root, process.env.PROBE_OUTPUT || 'docs/evidence/browser-probe.json');
await mkdir(resolve(path, '..'), {recursive: true});
await writeFile(path, JSON.stringify({ok: false, startedAt: new Date().toISOString(), error: 'Probe has not completed'}) + '\n');
await build({entryPoints: [resolve(root, 'spike/probe.mjs')], bundle: true, format: 'esm',
  outfile: resolve(root, 'spike/probe.bundle.mjs')});
const types = {'.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm'};
const server = createServer(async (request, response) => {
  try {
    const path = resolve(root, `.${new URL(request.url, 'http://localhost').pathname}`);
    if (!path.startsWith(root + sep)) throw new Error('Outside repository');
    const body = await readFile(path);
    response.writeHead(200, {'Content-Type': types[extname(path)] || 'application/octet-stream'});
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
let page;
const network = [];
const errors = [];
let result;
try {
  browser = await chromium.launch(process.env.CHROME_PATH ? {executablePath: process.env.CHROME_PATH} : {channel: 'chrome'});
  const context = await browser.newContext();
  page = await context.newPage();
  let phase = 'startup';
  context.on('response', response => {
    if (!response.url().startsWith('https://storage.googleapis.com/parquet.gtfsrt.io/')) return;
    const headers = response.headers();
    const request = response.request();
    network.push({phase, url: response.url(), method: request.method(), range: request.headers().range || null,
      status: response.status(), contentLength: Number(headers['content-length'] || 0),
      contentRange: headers['content-range'] || null, allowOrigin: headers['access-control-allow-origin'] || null});
  });
  page.on('console', message => {
    const text = message.text();
    if (text.startsWith('PROBE_START ')) phase = text.slice(12);
    else console.log(text);
  });
  context.on('requestfailed', request => console.error('REQUEST_FAILED', request.url(), request.failure()));
  page.on('pageerror', error => errors.push(String(error)));
  const port = server.address().port;
  await page.goto(`http://127.0.0.1:${port}/spike/index.html${process.env.PROBE_QUERY || ''}`);
  await page.waitForFunction(() => window.probeDone === true, undefined, {timeout: 180000});
  result = await page.evaluate(() => JSON.parse(JSON.stringify(window.probeResult, (_, v) => typeof v === 'bigint' ? v.toString() : v)));
} catch (error) {
  result = {ok: false, error: String(error), checks: []};
} finally {
  result ??= {ok: false, error: 'Probe did not return results', checks: []};
  result.network = network;
  result.browserErrors = errors;
  result.packageVersion = JSON.parse(await readFile(resolve(root, 'node_modules/@duckdb/duckdb-wasm/package.json'), 'utf8')).version;
  result.browserVersion = browser?.version();
  result.networkMeasurement = 'GET response Content-Length sums; excludes HEAD, TLS overhead and WASM assets. May include cached/overlapping bytes. Phase attribution is approximate.';
  await writeFile(path, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ok: result.ok, package: result.packageVersion, checks: result.checks.map(c => ({name: c.name, ok: c.ok, milliseconds: c.milliseconds, error: c.error})), evidence: path}, null, 2));
  if (!result.ok) process.exitCode = 1;
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
