import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {mkdir} from 'node:fs/promises';

const root = resolve(import.meta.dirname, '..');
const verify = spawnSync(process.execPath, [resolve(root, 'scripts/verify-release.mjs')], {cwd: root, stdio: 'inherit'});
if (verify.status !== 0) process.exit(verify.status ?? 1);
await mkdir(resolve(root, '.build'), {recursive: true});
const archive = resolve(root, '.build/gtfsrt-dashboard.tar.gz');
const result = spawnSync('tar', ['-czf', archive, '-C', resolve(root, 'dist'), '.'], {stdio: 'inherit'});
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`Packaged ${archive}`);
