import {mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import {extname, resolve} from 'node:path';
import {promisify} from 'node:util';
import {gzip} from 'node:zlib';
import {securityHeaders} from './security.mjs';

const root = resolve(import.meta.dirname, '..');
const config = resolve(root, '.build/hosting');
const gzipFile = promisify(gzip);
const compressible = new Set(['.css', '.html', '.js', '.mjs', '.wasm']);

async function compressRelease(directory) {
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await compressRelease(path);
      continue;
    }
    if (!compressible.has(extname(path))) continue;
    const bytes = await readFile(path);
    if (bytes.length < 1024) continue;
    await writeFile(`${path}.gz`, await gzipFile(bytes, {level: 9}));
  }
}

await compressRelease(resolve(root, 'dist'));
await mkdir(config, {recursive: true});
const headers = Object.entries(securityHeaders)
  .map(([name, value]) => `${name} ${JSON.stringify(value)}`)
  .join('\n');
await writeFile(resolve(config, 'security.caddy'), `${headers}\n`);
