import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOTIFICATION_KINDS } from './notification-kinds';

test('console consumes the lifecycle-notifications kit', () => {
  assert.equal(NOTIFICATION_KINDS.length, 16);
  assert.ok(NOTIFICATION_KINDS.includes('funding_empty'));
});
