import {test} from 'node:test';
import assert from 'node:assert/strict';
import {planDailyPositions, sha256, verifiedPositionBytes} from '../src/engine/sources/daily.ts';
import {parseChicagoManifest} from '../src/engine/sources/chicago.ts';
import {chicagoPositionURL} from '../src/engine/contracts.js';

test('Chicago partitions span 25 hours across fall DST and missing tails remain explicit', () => {
  const start = Date.parse('2026-11-01T05:00Z') / 1000;
  const end = Date.parse('2026-11-02T09:00Z') / 1000;
  const plan = planDailyPositions('America/Chicago', new Map([[20261101, [start, end]]]), new Map());
  assert.equal(plan.files[0].end - plan.files[0].start, 25 * 3600);
  assert.equal(plan.files.length, 2);
  assert.deepEqual(plan.files[1].completes, [20261101]);
  assert.equal(plan.files[1].handle, null);
});

test('overlapping service windows read each partition once', () => {
  const t = Date.parse('2026-11-02T09:00Z') / 1000;
  const plan = planDailyPositions('America/Chicago', new Map([
    [20261102, [t, t + 86400]], [20261103, [t + 86400, t + 172800]],
  ]), new Map());
  assert.equal(plan.files.length, 3);
  assert.deepEqual(plan.files.flatMap(f => f.completes), [20261102, 20261103]);
});

test('position content must match the declared size and digest', async () => {
  const bytes = new TextEncoder().encode('fixture');
  const hash = await sha256(bytes);
  assert.deepEqual(await verifiedPositionBytes(new Response(bytes), bytes.length, hash, 1024), bytes);
  await assert.rejects(verifiedPositionBytes(new Response(bytes), bytes.length, '0'.repeat(64), 1024), /checksum/);
  await assert.rejects(verifiedPositionBytes(new Response(bytes), bytes.length + 1, hash, 1024), /incomplete/);
  await assert.rejects(verifiedPositionBytes(new Response(bytes), bytes.length - 1, hash, 1024), /size/);
});

test('unsupported manifests and path escapes fail before a file is read', () => {
  assert.throws(() => parseChicagoManifest({manifest_version: 3}, 'a'.repeat(64)), /unsupported/);
  for (const path of ['https://evil.test/x', 'positions/../x', 'positions/%2e%2e/x', 'positions/index.json?token=x']) {
    assert.throws(() => chicagoPositionURL(path));
  }
});
