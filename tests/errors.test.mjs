import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EngineError, classifyError, errorDetails, friendlyError, reviveError, serializeError} from '../src/engine/errors.ts';

const kind = (error, context) => classifyError(error, context).kind;

test('classifies each failure category', () => {
  assert.equal(kind(new TypeError('Failed to fetch')), 'offline');
  assert.equal(kind(new TypeError('Load failed')), 'offline');
  assert.equal(kind(new DOMException('The operation timed out.', 'TimeoutError')), 'timeout');
  assert.equal(kind(new Error('The archive\'s inventory.json returned HTTP 503. Check your connection.')), 'http');
  assert.equal(kind(new Error('Archive 2026-11-06 returned HTTP 403. This is an access or network problem.')), 'http');
  assert.equal(kind(new Error('Out of Memory Error: could not allocate block (memory_limit 768MB)')), 'memory');
  // DuckDB wraps a dropped connection in its own error text. The cause is the network.
  assert.equal(kind(new Error("Invalid Error: Opening file 'feeds.parquet' failed with error: NetworkError: Failed to execute 'send' on 'XMLHttpRequest'")), 'offline');
  assert.equal(kind(new Error('IO Error: Could not read from file')), 'query');
  assert.equal(kind(new Error('Binder Error: Referenced column "x" not found')), 'query');
  assert.equal(kind(new Error('This browser needs WebAssembly. Try a current version.')), 'unsupported');
  assert.equal(kind(new Error('Your browser could not clear its saved results.')), 'cache');
  assert.equal(kind(new DOMException('full', 'QuotaExceededError')), 'cache');
  assert.equal(kind(new Error('The schedule for 2026-11-06 couldn\'t be read')), 'schedule');
  assert.equal(kind(new Error('The archive has no vehicle data for 2026-11-06.')), 'archive_missing');
  assert.equal(kind(new DOMException('aborted', 'AbortError')), 'cancelled');
  assert.equal(kind(new Error('something odd')), 'unknown');
  assert.equal(kind('a plain string'), 'unknown');
});

test('keeps the HTTP status and the original cause', () => {
  const original = new Error('Archive 2026-11-06 returned HTTP 429.');
  const error = classifyError(original, 'reading the 2026-11-06 archive file');
  assert.equal(error.status, 429);
  assert.equal(error.cause, original);
  assert.equal(error.context, 'reading the 2026-11-06 archive file');
  assert.match(error.detail, /Error: Archive 2026-11-06 returned HTTP 429/);
});

test('an already classified error passes through unchanged', () => {
  const error = new EngineError('cache', 'blocked');
  assert.equal(classifyError(error), error);
});

test('survives postMessage with its category, status and cause text', () => {
  const sent = JSON.parse(JSON.stringify(serializeError(new Error('Archive x returned HTTP 403.'), 'sizing a file')));
  const revived = reviveError(sent);
  assert.equal(revived.kind, 'http');
  assert.equal(revived.status, 403);
  assert.equal(revived.context, 'sizing a file');
  assert.ok(revived.cause instanceof Error);
  assert.match(revived.cause.stack, /HTTP 403/);
  // An old-style plain string is still understood.
  assert.equal(reviveError('Failed to fetch').kind, 'offline');
});

test('every category has plain-language text with advice', () => {
  const kinds = ['offline', 'timeout', 'http', 'archive_missing', 'schedule', 'memory', 'query', 'cache', 'unsupported', 'engine_crash', 'cancelled', 'unknown'];
  for (const k of kinds) {
    const friendly = friendlyError(new EngineError(k, 'raw text', {status: 500}));
    assert.ok(friendly.title.length > 5, k);
    assert.ok(friendly.advice.length > 10, k);
    assert.doesNotMatch(friendly.title + friendly.advice, /Binder|duckdb|std::/i, k);
  }
});

test('HTTP statuses get specific guidance', () => {
  const text = status => friendlyError(new EngineError('http', 'x', {status}));
  assert.match(text(403).title, /refused/);
  assert.match(text(429).advice, /Wait/);
  assert.match(text(503).title, /problem/);
  assert.equal(text(404).retryable, true);
});

test('details carry the category, status, context and original text', () => {
  const details = errorDetails(classifyError(new Error('Out of Memory Error: x'), 'reading the archive'));
  assert.match(details, /Category: memory/);
  assert.match(details, /While: reading the archive/);
  assert.match(details, /Out of Memory Error: x/);
});
