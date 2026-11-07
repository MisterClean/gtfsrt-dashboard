import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createServer} from 'vite';
import {chromium} from 'playwright';
const server = await createServer({server: {port: 4188, host: '127.0.0.1', strictPort: true}});
await server.listen();
const browser = await chromium.launch({headless: true, executablePath: process.env.CHROME_PATH || undefined});
try {
  const page = await browser.newPage();
  const requests = [];
  page.on('request', r => requests.push(r.url()));
  await page.goto('http://127.0.0.1:4188/tests/fixtures/local.html');
  await page.waitForFunction(() => typeof window.localFixture === 'function');
  const bytes = [...await readFile(new URL('./fixtures/positions.parquet', import.meta.url))];
  const data = await page.evaluate(bytes => window.localFixture(bytes), bytes);
  assert.equal(data.result.analyzed.length, 1);
  assert.ok(data.overview.speed > 3 && data.overview.speed < 4);
  assert.equal(data.routes[0].mode, 'Rail');
  assert.deepEqual(requests.filter(url => url.startsWith('http') && !url.startsWith('http://127.0.0.1:4188/')), []);
  assert.equal(requests.filter(url => url.includes('.parquet')).length, 0);
  console.log('Local File fixture analyzed through the shared worker, with no position file requests.');
} finally {
  await browser.close();
  await server.close();
}
