import { describe, expect, it } from 'vitest';
import { JINN_ROUTER_V3_ABI } from './jinn-router-v3.js';

describe('JINN_ROUTER_V3_ABI canonical reads', () => {
  it('exposes the deployed taskPayments getter used to reconstitute exact posting terms', () => {
    expect(JINN_ROUTER_V3_ABI.find((entry) =>
      entry.type === 'function' && entry.name === 'taskPayments')).toEqual({
      type: 'function',
      name: 'taskPayments',
      stateMutability: 'view',
      inputs: [{ name: 'taskId', type: 'uint256' }],
      outputs: [
        { name: 'creator', type: 'address' },
        { name: 'taskCidDigest', type: 'bytes32' },
        { name: 'manifestDigest', type: 'bytes32' },
        { name: 'solutionMaxDeliveryRate', type: 'uint256' },
        { name: 'verdictMaxDeliveryRate', type: 'uint256' },
        { name: 'responseTimeout', type: 'uint256' },
        { name: 'solutionBudgetRemaining', type: 'uint256' },
        { name: 'verdictBudgetRemaining', type: 'uint256' },
        { name: 'solutionBudgetRefunded', type: 'bool' },
        { name: 'verdictBudgetRefunded', type: 'bool' },
      ],
    });
  });
});
