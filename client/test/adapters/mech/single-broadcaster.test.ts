import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearVenueBroadcaster,
  executeSafeTransaction,
  setVenueBroadcaster,
  type VenueBroadcaster,
} from '../../../src/adapters/mech/safe.js';

const SAFE = '0x1111111111111111111111111111111111111111' as const;
const OTHER_SAFE = '0x9999999999999999999999999999999999999999' as const;
const ROUTER = '0x2222222222222222222222222222222222222222' as const;

/** Builds a stub venue-base broadcaster bound to `safeAddress` (finding E5: `execute`, not
 * `broadcast`; the Safe address is fixed at construction, not passed per call). */
function stubBroadcaster(
  execute: VenueBroadcaster['execute'],
  safeAddress: `0x${string}` = SAFE,
): VenueBroadcaster {
  return { safeAddress, execute };
}

afterEach(() => {
  clearVenueBroadcaster();
});

describe('single-broadcaster rule', () => {
  it('routes a legacy Safe execution through the injected venue broadcaster', async () => {
    const execute = vi.fn(async () => ({ txHash: `0x${'a'.repeat(64)}` as const }));
    setVenueBroadcaster(stubBroadcaster(execute));

    const txHash = await executeSafeTransaction(
      {} as never,
      {} as never,
      { safeAddress: SAFE, to: ROUTER, value: 0n, data: '0xdeadbeef' },
    );

    expect(txHash).toBe(`0x${'a'.repeat(64)}`);
    expect(execute).toHaveBeenCalledExactlyOnceWith({
      to: ROUTER,
      value: 0n,
      data: '0xdeadbeef',
      logicalTx: expect.any(String),
    });
  });

  it('runs every concurrent legacy leg through the same single installed broadcaster', async () => {
    const seen: string[] = [];
    setVenueBroadcaster(stubBroadcaster(async (input) => {
      seen.push(input.data);
      return { txHash: `0x${'b'.repeat(64)}` as const };
    }));

    await Promise.all(
      ['0x01', '0x02', '0x03'].map((data) =>
        executeSafeTransaction({} as never, {} as never, {
          safeAddress: SAFE,
          to: ROUTER,
          value: 0n,
          data: data as `0x${string}`,
        }),
      ),
    );

    // All three legs landed on the one installed broadcaster instance — a
    // second, independent broadcaster/nonce stack against this Safe never
    // gets a chance to race it (the #525/#562/#897 failure class).
    expect(seen.sort()).toEqual(['0x01', '0x02', '0x03']);
  });

  it('still fires the beforeBroadcast fence and onBroadcast hook in order', async () => {
    const order: string[] = [];
    setVenueBroadcaster(stubBroadcaster(async () => {
      order.push('broadcast');
      return { txHash: `0x${'c'.repeat(64)}` as const };
    }));
    await executeSafeTransaction(
      {} as never,
      {} as never,
      { safeAddress: SAFE, to: ROUTER, value: 0n, data: '0x00' },
      {
        beforeBroadcast: () => {
          order.push('before');
        },
        onBroadcast: () => {
          order.push('after');
        },
      },
    );
    expect(order).toEqual(['before', 'broadcast', 'after']);
  });

  it('refuses to broadcast when no venue broadcaster is installed', async () => {
    await expect(
      executeSafeTransaction({} as never, {} as never, {
        safeAddress: SAFE,
        to: ROUTER,
        value: 0n,
        data: '0x00',
      }),
    ).rejects.toThrow('no venue broadcaster installed');
  });

  it('refuses to broadcast against a Safe the installed broadcaster is not bound to', async () => {
    const execute = vi.fn(async () => ({ txHash: `0x${'d'.repeat(64)}` as const }));
    setVenueBroadcaster(stubBroadcaster(execute, OTHER_SAFE));

    await expect(
      executeSafeTransaction({} as never, {} as never, {
        safeAddress: SAFE,
        to: ROUTER,
        value: 0n,
        data: '0x00',
      }),
    ).rejects.toThrow(/mismatch|does not match/i);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('logicalTx derivation (finding E5 — load-bearing for the venue reconcile path)', () => {
  it('derives the same logicalTx for identical params — a retry adopts the same pending tx', async () => {
    const seen: string[] = [];
    setVenueBroadcaster(stubBroadcaster(async (input) => {
      seen.push(input.logicalTx);
      return { txHash: `0x${'e'.repeat(64)}` as const };
    }));
    const params = { safeAddress: SAFE, to: ROUTER, value: 0n, data: '0xdeadbeef' as const };

    await executeSafeTransaction({} as never, {} as never, params);
    await executeSafeTransaction({} as never, {} as never, params);

    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
  });

  it('derives a different logicalTx when only the calldata differs — distinct operations never collide', async () => {
    const seen: string[] = [];
    setVenueBroadcaster(stubBroadcaster(async (input) => {
      seen.push(input.logicalTx);
      return { txHash: `0x${'f'.repeat(64)}` as const };
    }));

    await executeSafeTransaction({} as never, {} as never, {
      safeAddress: SAFE,
      to: ROUTER,
      value: 0n,
      data: '0xaaaaaaaa',
    });
    await executeSafeTransaction({} as never, {} as never, {
      safeAddress: SAFE,
      to: ROUTER,
      value: 0n,
      data: '0xbbbbbbbb',
    });

    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  });
});
