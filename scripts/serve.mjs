import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve, extname, sep} from 'node:path';
import {securityHeaders} from './security.mjs';

const root = resolve(import.meta.dirname, '../dist');
const base = '/gtfsrt-dashboard/';
const port = Number(process.env.PORT || 4173);
const mime = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.json': 'application/json'};
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/' || url.pathname === '/gtfsrt-dashboard') {
    response.writeHead(302, {...securityHeaders, Location: base + url.search}).end(); return;
  }
  try {
    if (!['GET', 'HEAD'].includes(request.method) || !url.pathname.startsWith(base)) throw new Error('Not found');
    const pathname = decodeURIComponent(url.pathname.slice(base.length));
    const path = resolve(root, pathname || 'index.html');
    if (!path.startsWith(root + sep)) throw new Error('Outside release');
    const body = await readFile(path);
    response.writeHead(200, {...securityHeaders, 'Content-Type': mime[extname(path)] || 'application/octet-stream', 'Content-Length': body.length, 'Cache-Control': 'no-cache'});
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch { response.writeHead(404, securityHeaders).end('Not found'); }
});
server.listen(port, '127.0.0.1', () => console.log(`Open http://127.0.0.1:${port}${base}`));
