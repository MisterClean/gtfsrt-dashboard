import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ARCHIVE, MAX_BYTES, validateArchiveURL, validateManifest, enforceObjectBudget} from '../web/contracts.js';
import {securityHeaders} from '../scripts/security.mjs';

const file = (index = 0) => ({url: `${ARCHIVE}vehicle_positions/date=2026-11-05/base64url=cHVibGlj/data.parquet`, alias: `day_${index}.parquet`});

test('rejects other buckets, credentialed URLs, query strings, and encoded path escapes', () => {
  assert.equal(validateArchiveURL(file().url), file().url);
  for (const url of [
    'https://storage.googleapis.com/another-bucket/data.parquet',
    'https://storage.googleapis.com/parquet.gtfsrt.io.evil/data.parquet',
    'https://storage.googleapis.com.evil.test/parquet.gtfsrt.io/data.parquet',
    'https://user:password@storage.googleapis.com/parquet.gtfsrt.io/data.parquet',
    `${file().url}?token=private`, `${file().url}#fragment`,
    `${ARCHIVE}../another-bucket/data.parquet`, `${ARCHIVE}vehicle_positions/%2fother/data.parquet`,
    'http://storage.googleapis.com/parquet.gtfsrt.io/data.parquet',
  ]) assert.throws(() => validateArchiveURL(url), undefined, url);
});

test('allows only exact bounded vehicle archive paths and generated aliases', () => {
  validateManifest([file()]);
  validateManifest(Array.from({length: 6}, (_, i) => file(i)));
  for (const files of [[], Array.from({length: 7}, (_, i) => file(i)), [{...file(), alias: "bad'alias"}], [{...file(), url: `${ARCHIVE}feeds.parquet`}], [{...file(), url: file().url.replace('cHVibGlj', "a'b")}]]) assert.throws(() => validateManifest(files));
});

test('checks the whole selection and keeps missing objects distinct from empty service', () => {
  assert.equal(enforceObjectBudget([{bytes: MAX_BYTES, status: 'available'}, {bytes: 0, status: 'missing'}]), MAX_BYTES);
  assert.throws(() => enforceObjectBudget([{bytes: MAX_BYTES, status: 'available'}, {bytes: 1, status: 'available'}]), /128 MiB/);
  assert.throws(() => enforceObjectBudget([{bytes: 0, status: 'missing'}]), /does not mean no service/);
});

test('the response policy constrains worker networking and allows WASM without JavaScript eval', () => {
  const policy = securityHeaders['Content-Security-Policy'];
  assert.match(policy, /connect-src 'self' https:\/\/storage\.googleapis\.com\/parquet\.gtfsrt\.io\//);
  assert.match(policy, /worker-src 'self'/);
  assert.match(policy, /'wasm-unsafe-eval'/);
  assert.ok(!policy.includes("'unsafe-eval'"));
  assert.equal(securityHeaders['Referrer-Policy'], 'no-referrer');
});
