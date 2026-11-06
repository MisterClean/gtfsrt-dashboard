import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';

export const extensions = [
  {name: 'parquet', sha256: 'd8dc437687baa417b55a2ed4d251f6c2fe92732cc7d8f7904845b63e7627ac7b'},
  {name: 'icu', sha256: '0e379b9d688f0df82192f15f9405f60861f478956ad0282ce831572695458308'},
];

export async function prepareExtensions(root) {
  const directory = resolve(root, '.cache/duckdb-extensions');
  await mkdir(directory, {recursive: true});
  for (const extension of extensions) {
    const name = `${extension.name}.duckdb_extension.wasm`;
    const path = resolve(directory, name);
    let bytes;
    try { bytes = await readFile(path); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const url = `https://extensions.duckdb.org/v2.0.0/wasm_eh/${name}`;
      console.log(`Downloading the pinned ${extension.name} extension from DuckDB’s official repository`);
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Extension download returned HTTP ${response.status}: ${url}`);
      bytes = new Uint8Array(await response.arrayBuffer());
    }
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== extension.sha256) throw new Error(`The ${extension.name} extension failed its SHA-256 check. Audit the dependency before updating the pin.`);
    await writeFile(path, bytes);
  }
  return directory;
}
