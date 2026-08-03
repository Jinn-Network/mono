import { describe, expect, it, vi } from 'vitest';
import { encodeErrorResult, parseAbi } from 'viem';
import { createDirectSafeBroadcaster } from '../../../src/adapters/mech/direct-safe-broadcaster.js';
import { SafeInnerRevertError } from '../../../src/adapters/mech/safe-revert.js';

const SAFE = '0x1111111111111111111111111111111111111111' as const;
const ROUTER = '0x2222222222222222222222222222222222222222' as const;
const OWNER = '0x3333333333333333333333333333333333333333' as const;
const REQUEST_ID = `0x${'44'.repeat(32)}` as const;

describe('direct Safe broadcaster', () => {
  it('recovers and exposes the inner custom error hidden by Safe GS013', async () => {
    const innerData = encodeErrorResult({
      abi: parseAbi(['error RouterWrongRequestKind(bytes32 requestId, uint8 expected, uint8 actual)']),
      errorName: 'RouterWrongRequestKind',
      args: [REQUEST_ID, 1, 2],
    });
    const publicClient = {
      readContract: vi.fn()
        .mockResolvedValueOnce(0n)
        .mockResolvedValueOnce(`0x${'55'.repeat(32)}`),
      call: vi.fn().mockRejectedValue({ data: innerData }),
      waitForTransactionReceipt: vi.fn(),
    };
    const walletClient = {
      account: { address: OWNER },
      chain: { id: 8453 },
      signMessage: vi.fn().mockResolvedValue(`0x${'66'.repeat(64)}1b`),
      writeContract: vi.fn().mockRejectedValue(new Error('execution reverted: GS013')),
    };
    const broadcaster = createDirectSafeBroadcaster(
      publicClient as never,
      walletClient as never,
      SAFE,
    );

    await expect(broadcaster.execute({
      to: ROUTER,
      value: 0n,
      data: '0xdeadbeef',
      logicalTx: 'test:inner-revert',
    })).rejects.toMatchObject({
      name: 'SafeInnerRevertError',
      decodedName: 'RouterWrongRequestKind',
      innerSelector: '0x51cba8b3',
    } satisfies Partial<SafeInnerRevertError>);

    expect(publicClient.call).toHaveBeenCalledExactlyOnceWith({
      account: SAFE,
      to: ROUTER,
      data: '0xdeadbeef',
      value: 0n,
    });
    expect(publicClient.waitForTransactionReceipt).not.toHaveBeenCalled();
  });
});
