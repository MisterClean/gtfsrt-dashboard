import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve, extname, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
await build({entryPoints: [resolve(root, 'spike/probe.mjs')], bundle: true, format: 'esm',
  outfile: resolve(root, 'spike/probe.bundle.mjs')});
const types = {'.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm'};
createServer(async (request, response) => {
  try {
    const path = resolve(root, `.${new URL(request.url, 'http://localhost').pathname}`);
    if (!path.startsWith(root + sep)) throw new Error('Outside repository');
    const body = await readFile(path);
    response.writeHead(200, {'Content-Type': types[extname(path)] || 'application/octet-stream'});
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
}).listen(4173, '127.0.0.1', () => console.log('Open http://127.0.0.1:4173/spike/index.html'));
