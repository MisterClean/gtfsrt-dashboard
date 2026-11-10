import assert from 'node:assert/strict';
import {test} from 'node:test';
import {hasRouteBadgeContrast} from '../src/lib/route-badge.ts';

test('route badges keep agency colors only when the pair is readable', () => {
  assert.equal(hasRouteBadgeContrast('969696', 'FFFFFF'), false);
  assert.equal(hasRouteBadgeContrast('969696', '000000'), true);
  assert.equal(hasRouteBadgeContrast('777777', 'FFFFFF'), false);
  assert.equal(hasRouteBadgeContrast('767676', 'FFFFFF'), true);
  assert.equal(hasRouteBadgeContrast('FFFFFF', 'ffffff'), false);
  assert.equal(hasRouteBadgeContrast('', '000000'), false);
  assert.equal(hasRouteBadgeContrast('969696', 'invalid'), false);
});
