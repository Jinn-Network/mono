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

  // D0a round-1 review (minor finding): the docstring's "a CLI verb submits exactly one Safe
  // transaction per invocation" premise is violated by `jinn solver-plugins`, which builds TWO
  // independent `createDirectSafeBroadcaster` instances for the SAME agent EOA (publish's
  // publisherFactory and the reputation write client) that can both be exercised in one process.
  // With no per-EOA lock, two `execute()` calls from those two instances could race each other's
  // nonce read. Opting into `withEoaBroadcastLock` (already exported for exactly this) closes it.
  function makeBroadcaster(
    label: string,
    order: string[],
    opts: { gate?: Promise<void> } = {},
  ) {
    const publicClient = {
      readContract: vi.fn()
        .mockResolvedValueOnce(0n) // nonce
        .mockResolvedValueOnce(`0x${'55'.repeat(32)}`), // safeTxHash
      waitForTransactionReceipt: vi.fn(),
    };
    const walletClient = {
      account: { address: OWNER },
      chain: { id: 8453 },
      signMessage: vi.fn(async () => {
        order.push(`${label}-start`);
        if (opts.gate) await opts.gate;
        order.push(`${label}-signed`);
        return `0x${'66'.repeat(64)}1b`;
      }),
      writeContract: vi.fn().mockResolvedValue(`0x${'77'.repeat(32)}`),
    };
    return createDirectSafeBroadcaster(publicClient as never, walletClient as never, SAFE);
  }

  it('serializes concurrent executes for the SAME EOA across two independent broadcaster instances', async () => {
    const order: string[] = [];
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
    const broadcasterA = makeBroadcaster('a', order, { gate: gateA });
    const broadcasterB = makeBroadcaster('b', order);

    const execA = broadcasterA.execute({ to: ROUTER, value: 0n, data: '0x', logicalTx: 'a' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(['a-start']);

    const execB = broadcasterB.execute({ to: ROUTER, value: 0n, data: '0x', logicalTx: 'b' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    // B must NOT have started yet -- it should be waiting on the shared per-EOA lock, not racing
    // A's in-flight nonce read.
    expect(order).toEqual(['a-start']);

    releaseA();
    await Promise.all([execA, execB]);
    expect(order).toEqual(['a-start', 'a-signed', 'b-start', 'b-signed']);
  });
});
