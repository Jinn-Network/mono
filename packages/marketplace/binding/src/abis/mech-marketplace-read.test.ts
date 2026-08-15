import { describe, expect, it } from 'vitest';
import { MECH_MARKETPLACE_ABI, MECH_OPERATOR_ABI } from './mech-marketplace.js';

describe('Mech marketplace authorization reads', () => {
  it('exposes the deployed marketplace registration and Mech operator getters', () => {
    expect(MECH_MARKETPLACE_ABI).toContainEqual({
      type: 'function',
      name: 'mapAgentMechFactories',
      stateMutability: 'view',
      inputs: [{ name: 'mech', type: 'address' }],
      outputs: [{ name: 'factory', type: 'address' }],
    });
    expect(MECH_OPERATOR_ABI).toEqual([{
      type: 'function',
      name: 'getOperator',
      stateMutability: 'view',
      inputs: [],
      outputs: [{ name: 'operator', type: 'address' }],
    }]);
  });
});
