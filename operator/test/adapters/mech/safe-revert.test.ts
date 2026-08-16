import { describe, expect, it, vi } from 'vitest';
import { encodeErrorResult, parseAbi } from 'viem';
import {
  decodeSafeInnerRevert,
  formatKnownRevert,
  formatKnownRevertDetail,
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

  it('formats known selectors from viem simulation errors without full revert data', () => {
    const error = new Error(
      'The contract function "claimEvaluation" reverted with the following signature:\n0xbe465de7\n\nUnable to decode signature "0xbe465de7" as it was not found on the provided ABI.',
    );

    expect(formatKnownRevert(error)).toBe('TCAttemptAlreadyFinalized');
  });

  describe('formatKnownRevertDetail — structured name alongside formatted reason', () => {
    it('returns the bare structured name plus the formatted reason for a decoded revert', () => {
      const errorData = encodeErrorResult({
        abi: ROUTER_V3_ERROR_ABI,
        errorName: 'TCAttemptAlreadyFinalized',
        args: [92n, 0],
      });
      const detail = formatKnownRevertDetail({ data: errorData });

      expect(detail).not.toBeNull();
      // Structured name is the bare identifier — never the formatted Name(args) form.
      expect(detail!.name).toBe('TCAttemptAlreadyFinalized');
      // Formatted reason keeps the args for operator-facing log lines.
      expect(detail!.reason).toBe('TCAttemptAlreadyFinalized(92, 0)');
      // Terminal classification works directly off the structured name.
      expect(isNonRecoverableInnerRevert(detail!.name)).toBe(true);
    });

    it('returns the structured name when only the selector is available (no arg data)', () => {
      const error = new Error(
        'reverted with the following signature:\n0xbe465de7\n',
      );
      const detail = formatKnownRevertDetail(error);

      expect(detail).not.toBeNull();
      expect(detail!.name).toBe('TCAttemptAlreadyFinalized');
      expect(detail!.reason).toBe('TCAttemptAlreadyFinalized');
    });

    it('keeps the structured name intact when an arg renders with a "(" that a regex strip would corrupt', () => {
      // RouterRefundFailed(address receiver, uint256 amount) — decodeAbiParameters
      // hands `formatDecodedRevert` an address string. If that arg value ever
      // renders with a "(" in it, the old `reason.replace(/\(.*$/, '')` strip
      // would corrupt the bare name. The structured `name` field never round-trips
      // through that formatting, so it stays exact regardless of the reason text.
      const errorData = encodeErrorResult({
        abi: parseAbi(['error RouterRefundFailed(address receiver, uint256 amount)']),
        errorName: 'RouterRefundFailed',
        args: ['0x5555555555555555555555555555555555555555', 7n],
      });
      const detail = formatKnownRevertDetail({ data: errorData });

      expect(detail).not.toBeNull();
      expect(detail!.name).toBe('RouterRefundFailed');
      // Even if a downstream caller later mangled `reason` so it contained a
      // leading "(", classification on the structured `name` is unaffected.
      const corruptedReason = '(0x5555...)RouterRefundFailed';
      expect(corruptedReason.replace(/\(.*$/s, '').trim()).toBe('');
      expect(isNonRecoverableInnerRevert(detail!.name)).toBe(true);
    });

    it('returns null for an unknown selector so callers fall back to flattenErrorMessage', () => {
      const error = new Error('execution reverted: 0xdeadbeef');
      expect(formatKnownRevertDetail(error)).toBeNull();
    });
  });
});
