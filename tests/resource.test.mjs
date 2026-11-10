import {test} from 'node:test';
import assert from 'node:assert/strict';
import {beginLoad, emptyResource, loadFailed, loadSucceeded, statusOf} from '../src/lib/resource.ts';

test('starts empty', () => {
  assert.equal(statusOf(emptyResource()), 'empty');
});

test('the first load is loading, then ready', () => {
  let state = beginLoad(emptyResource(), 'route 2');
  assert.equal(statusOf(state), 'loading');
  state = loadSucceeded(state, {n: 1});
  assert.equal(statusOf(state), 'ready');
  assert.deepEqual(state.value, {n: 1});
});

test('asking again for the same subject keeps the answer up while it refreshes', () => {
  let state = loadSucceeded(beginLoad(emptyResource(), 'route 2'), 'old');
  state = beginLoad(state, 'route 2');
  assert.equal(statusOf(state), 'refreshing');
  assert.equal(state.value, 'old');
  assert.equal(loadSucceeded(state, 'new').value, 'new');
});

test('a new subject never shows the last subject\'s answer', () => {
  let state = loadSucceeded(beginLoad(emptyResource(), 'route 2'), 'route 2 report');
  state = beginLoad(state, 'route 80');
  assert.equal(state.value, null);
  assert.equal(statusOf(state), 'loading');
});

test('a failed refresh removes the old answer and says why', () => {
  let state = loadSucceeded(beginLoad(emptyResource(), 'stops'), 'old');
  state = loadFailed(beginLoad(state, 'stops'), 'It broke.');
  assert.equal(statusOf(state), 'failed');
  assert.equal(state.value, null);
  assert.equal(state.failure, 'It broke.');
});

test('trying again after a failure clears the failure once it works', () => {
  let state = loadFailed(beginLoad(emptyResource(), 'stops'), 'It broke.');
  state = beginLoad(state, 'stops');
  assert.equal(statusOf(state), 'loading');
  state = loadSucceeded(state, 'fine');
  assert.equal(state.failure, null);
  assert.equal(statusOf(state), 'ready');
});
