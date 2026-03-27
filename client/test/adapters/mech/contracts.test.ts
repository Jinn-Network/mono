import { describe, it, expect } from 'vitest';
import { encodeFunctionData, decodeFunctionData } from 'viem';
import { JINN_ROUTER_ABI, NATIVE_PAYMENT_TYPE } from '../../../src/adapters/mech/types.js';

describe('JinnRouter contract encoding', () => {
  it('encodes createRestorationJob calldata', () => {
    const calldata = encodeFunctionData({
      abi: JINN_ROUTER_ABI,
      functionName: 'createRestorationJob',
      args: [
        '0xabcd' as `0x${string}`,
        '0x1234567890123456789012345678901234567890' as `0x${string}`,
        1000000n,
        300n,
        NATIVE_PAYMENT_TYPE,
        '0x' as `0x${string}`,
      ],
    });
    expect(calldata).toMatch(/^0x/);

    const decoded = decodeFunctionData({
      abi: JINN_ROUTER_ABI,
      data: calldata,
    });
    expect(decoded.functionName).toBe('createRestorationJob');
  });

  it('encodes createEvaluationJob calldata with restorationRequestId', () => {
    const restorationRequestId = ('0x' + 'aa'.repeat(32)) as `0x${string}`;
    const calldata = encodeFunctionData({
      abi: JINN_ROUTER_ABI,
      functionName: 'createEvaluationJob',
      args: [
        restorationRequestId,
        '0xabcd' as `0x${string}`,
        '0x1234567890123456789012345678901234567890' as `0x${string}`,
        1000000n,
        300n,
        NATIVE_PAYMENT_TYPE,
        '0x' as `0x${string}`,
      ],
    });

    const decoded = decodeFunctionData({
      abi: JINN_ROUTER_ABI,
      data: calldata,
    });
    expect(decoded.functionName).toBe('createEvaluationJob');
    expect((decoded.args as unknown[])[0]).toBe(restorationRequestId);
  });

  it('encodes claimDelivery calldata', () => {
    const requestId = ('0x' + 'bb'.repeat(32)) as `0x${string}`;
    const calldata = encodeFunctionData({
      abi: JINN_ROUTER_ABI,
      functionName: 'claimDelivery',
      args: [requestId],
    });

    const decoded = decodeFunctionData({
      abi: JINN_ROUTER_ABI,
      data: calldata,
    });
    expect(decoded.functionName).toBe('claimDelivery');
    expect((decoded.args as unknown[])[0]).toBe(requestId);
  });
});
