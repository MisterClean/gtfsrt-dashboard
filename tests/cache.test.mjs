import {test} from 'node:test';
import assert from 'node:assert/strict';

// A browser where IndexedDB is switched off: open() throws, as it does in some private windows.
globalThis.indexedDB = {open() { throw new Error('SecurityError: The operation is insecure.'); }};
const warnings = [];
console.warn = (...args) => warnings.push(args.map(String).join(' '));

const {getEntry, putEntry, listDays, onCacheProblem} = await import('../src/engine/cache.ts');

test('a broken IndexedDB is logged and reported once, and reads fall through', async () => {
  const notices = [];
  onCacheProblem(message => notices.push(message));

  assert.equal(await getEntry('days', 'a|1|1'), null);
  assert.equal(await putEntry('days', 'a|1|1', {x: 1}), false);
  assert.deepEqual(await listDays('a', 1), {dates: [], bytes: 0});

  assert.equal(notices.length, 1, 'one visible notice, not one per call');
  assert.match(notices[0], /isn't keeping saved results/);
  assert.ok(warnings.some(line => line.includes('[cache]') && line.includes('opening the database')), 'the failure is logged');
});
