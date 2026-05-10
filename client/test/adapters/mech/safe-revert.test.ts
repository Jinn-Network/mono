import { describe, expect, it, vi } from 'vitest';
import { encodeErrorResult, parseAbi } from 'viem';
import {
  decodeSafeInnerRevert,
  isNonRecoverableInnerRevert,
} from '../../../src/adapters/mech/safe-revert.js';

const ROUTER_V3_ERROR_ABI = parseAbi([
  'error RouterWrongRequestKind(bytes32 requestId, uint8 expected, uint8 actual)',
  'error RouterWrongDeliveryOperator(bytes32 requestId, address expectedOperator, address deliveryMech)',
  'error RouterNotDelivered(bytes32 requestId)',
  'error TCAttemptClaimExpired(uint256 taskId, uint32 attemptIndex)',
  'error TCAttemptAlreadyFinalized(uint256 taskId, uint32 attemptIndex)',
]);

describe('Safe inner revert decoding', () => {
  const requestId = `0x${'11'.repeat(32)}` as `0x${string}`;
  const safeParams = {
    safeAddress: '0x1111111111111111111111111111111111111111' as `0x${string}`,
    to: '0x2222222222222222222222222222222222222222' as `0x${string}`,
    value: 0n,
    data: '0x12345678' as `0x${string}`,
  };

  it('decodes JinnRouterV3 wrong-kind reverts from the inner call', async () => {
    const errorData = encodeErrorResult({
      abi: ROUTER_V3_ERROR_ABI,
      errorName: 'RouterWrongRequestKind',
      args: [requestId, 1, 2],
    });
    const publicClient = {
      call: vi.fn().mockRejectedValue({ data: errorData }),
    };

    const decoded = await decodeSafeInnerRevert(publicClient as never, safeParams);

    expect(decoded.innerSelector).toBe('0x51cba8b3');
    expect(decoded.decodedName).toBe('RouterWrongRequestKind');
    expect(decoded.decodedArgs?.[0]).toBe(requestId);
    expect(decoded.decodedArgs?.[1]).toBe(1);
    expect(decoded.decodedArgs?.[2]).toBe(2);
  });

  it('decodes JinnRouterV3 delivery-operator reverts from nested data', async () => {
    const expectedOperator = '0x3333333333333333333333333333333333333333';
    const deliveryMech = '0x4444444444444444444444444444444444444444';
    const errorData = encodeErrorResult({
      abi: ROUTER_V3_ERROR_ABI,
      errorName: 'RouterWrongDeliveryOperator',
      args: [requestId, expectedOperator, deliveryMech],
    });
    const publicClient = {
      call: vi.fn().mockRejectedValue({ data: { data: errorData } }),
    };

    const decoded = await decodeSafeInnerRevert(publicClient as never, safeParams);

    expect(decoded.innerSelector).toBe('0x601188e3');
    expect(decoded.decodedName).toBe('RouterWrongDeliveryOperator');
    expect(decoded.decodedArgs?.[1]).toBe(expectedOperator);
    expect(decoded.decodedArgs?.[2]).toBe(deliveryMech);
  });

  it('keeps RouterNotDelivered recoverable but marks terminal V3 errors non-recoverable', () => {
    expect(isNonRecoverableInnerRevert('RouterWrongRequestKind')).toBe(true);
    expect(isNonRecoverableInnerRevert('RouterWrongDeliveryOperator')).toBe(true);
    expect(isNonRecoverableInnerRevert('RouterAlreadyClaimed')).toBe(true);
    expect(isNonRecoverableInnerRevert('RouterNotDelivered')).toBe(false);
  });

  it('decodes expired TaskCoordinator attempt claims as non-recoverable', async () => {
    const errorData = encodeErrorResult({
      abi: ROUTER_V3_ERROR_ABI,
      errorName: 'TCAttemptClaimExpired',
      args: [37n, 0],
    });
    const publicClient = {
      call: vi.fn().mockRejectedValue({ data: errorData }),
    };

    const decoded = await decodeSafeInnerRevert(publicClient as never, safeParams);

    expect(decoded.innerSelector).toBe('0x1c48587f');
    expect(decoded.decodedName).toBe('TCAttemptClaimExpired');
    expect(decoded.decodedArgs?.[0]).toBe(37n);
    expect(decoded.decodedArgs?.[1]).toBe(0);
    expect(isNonRecoverableInnerRevert(decoded.decodedName)).toBe(true);
  });

  it('decodes finalized TaskCoordinator attempts as non-recoverable', async () => {
    const errorData = encodeErrorResult({
      abi: ROUTER_V3_ERROR_ABI,
      errorName: 'TCAttemptAlreadyFinalized',
      args: [92n, 0],
    });
    const publicClient = {
      call: vi.fn().mockRejectedValue({ data: errorData }),
    };

    const decoded = await decodeSafeInnerRevert(publicClient as never, safeParams);

    expect(decoded.innerSelector).toBe('0xbe465de7');
    expect(decoded.decodedName).toBe('TCAttemptAlreadyFinalized');
    expect(decoded.decodedArgs?.[0]).toBe(92n);
    expect(decoded.decodedArgs?.[1]).toBe(0);
    expect(isNonRecoverableInnerRevert(decoded.decodedName)).toBe(true);
  });
});
