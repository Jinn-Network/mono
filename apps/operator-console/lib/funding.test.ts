import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatWeiAsEth, isAwaitingFunding } from './funding';

test('formats 0.015 ETH from wei', () => {
  assert.equal(formatWeiAsEth('15000000000000000'), '0.015 ETH');
});

test('awaiting funding is setup + awaiting_funding', () => {
  assert.equal(
    isAwaitingFunding({ mode: 'setup', currentStep: 'awaiting_funding' }),
    true,
  );
  assert.equal(isAwaitingFunding({ mode: 'running', currentStep: 'complete' }), false);
});
