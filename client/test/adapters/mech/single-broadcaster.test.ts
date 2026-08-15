import { describe, expect, it, vi } from 'vitest';
import {
  executeSafeTransaction,
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

describe('per-daemon broadcaster (finding E16 / the C2 ruling)', () => {
  it('routes a legacy Safe execution through the explicitly-supplied broadcaster', async () => {
    const execute = vi.fn(async () => ({ txHash: `0x${'a'.repeat(64)}` as const }));
    const broadcaster = stubBroadcaster(execute);

    const txHash = await executeSafeTransaction(
      {} as never,
      {} as never,
      { safeAddress: SAFE, to: ROUTER, value: 0n, data: '0xdeadbeef' },
      broadcaster,
    );

    expect(txHash).toBe(`0x${'a'.repeat(64)}`);
    expect(execute).toHaveBeenCalledExactlyOnceWith({
      to: ROUTER,
      value: 0n,
      data: '0xdeadbeef',
      logicalTx: expect.any(String),
    });
  });

  it('runs every concurrent legacy leg through the same supplied broadcaster', async () => {
    const seen: string[] = [];
    const broadcaster = stubBroadcaster(async (input) => {
      seen.push(input.data);
      return { txHash: `0x${'b'.repeat(64)}` as const };
    });

    await Promise.all(
      ['0x01', '0x02', '0x03'].map((data) =>
        executeSafeTransaction({} as never, {} as never, {
          safeAddress: SAFE,
          to: ROUTER,
          value: 0n,
          data: data as `0x${string}`,
        }, broadcaster),
      ),
    );

    // All three legs landed on the one supplied broadcaster instance — a
    // second, independent broadcaster/nonce stack against this Safe never
    // gets a chance to race it (the #525/#562/#897 failure class).
    expect(seen.sort()).toEqual(['0x01', '0x02', '0x03']);
  });

  it('still fires the beforeBroadcast fence and onBroadcast hook in order', async () => {
    const order: string[] = [];
    const broadcaster = stubBroadcaster(async () => {
      order.push('broadcast');
      return { txHash: `0x${'c'.repeat(64)}` as const };
    });
    await executeSafeTransaction(
      {} as never,
      {} as never,
      { safeAddress: SAFE, to: ROUTER, value: 0n, data: '0x00' },
      broadcaster,
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

  it('refuses to broadcast when no broadcaster is supplied for this call', async () => {
    await expect(
      executeSafeTransaction({} as never, {} as never, {
        safeAddress: SAFE,
        to: ROUTER,
        value: 0n,
        data: '0x00',
      }, undefined),
    ).rejects.toThrow('no venue broadcaster supplied');
  });

  it('refuses to broadcast against a Safe the supplied broadcaster is not bound to', async () => {
    const execute = vi.fn(async () => ({ txHash: `0x${'d'.repeat(64)}` as const }));
    const broadcaster = stubBroadcaster(execute, OTHER_SAFE);

    await expect(
      executeSafeTransaction({} as never, {} as never, {
        safeAddress: SAFE,
        to: ROUTER,
        value: 0n,
        data: '0x00',
      }, broadcaster),
    ).rejects.toThrow(/mismatch|does not match/i);
    expect(execute).not.toHaveBeenCalled();
  });

  /**
   * THE PROOF the C2 ruling demands: two daemons in one process, each holding a different Safe's
   * broadcaster, each broadcasting independently — the exact scenario a process-global
   * `venueBroadcaster` singleton made impossible (finding E16 item 3; release scenario T2.2 and
   * `jinn-repo-loop.ts` run two operators per process). Before this change, `setVenueBroadcaster`
   * was a single module-level variable: installing the second daemon's broadcaster would silently
   * rebind the first daemon's Safe too, and the first daemon's subsequent calls would either
   * broadcast against the WRONG Safe or (with the E5 bound-Safe check) throw a mismatch error —
   * this test fails against that design because there is only one slot for two Safes.
   */
  it('lets two daemons in one process each hold and broadcast through their own Safe', async () => {
    const opASeen: string[] = [];
    const opBSeen: string[] = [];
    const OP_A_SAFE = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1' as const;
    const OP_B_SAFE = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2' as const;

    const opABroadcaster = stubBroadcaster(async (input) => {
      opASeen.push(input.data);
      return { txHash: `0x${'a1'.repeat(32)}` as const };
    }, OP_A_SAFE);
    const opBBroadcaster = stubBroadcaster(async (input) => {
      opBSeen.push(input.data);
      return { txHash: `0x${'b2'.repeat(32)}` as const };
    }, OP_B_SAFE);

    // Interleaved, not sequential: op-a and op-b broadcast concurrently, each through its own
    // explicitly-threaded broadcaster, each against its own Safe.
    const [opAResult, opBResult] = await Promise.all([
      executeSafeTransaction({} as never, {} as never, {
        safeAddress: OP_A_SAFE,
        to: ROUTER,
        value: 0n,
        data: '0xa000',
      }, opABroadcaster),
      executeSafeTransaction({} as never, {} as never, {
        safeAddress: OP_B_SAFE,
        to: ROUTER,
        value: 0n,
        data: '0xb000',
      }, opBBroadcaster),
    ]);

    expect(opAResult).toBe(`0x${'a1'.repeat(32)}`);
    expect(opBResult).toBe(`0x${'b2'.repeat(32)}`);
    // Each Safe's traffic landed ONLY on its own broadcaster — no cross-talk.
    expect(opASeen).toEqual(['0xa000']);
    expect(opBSeen).toEqual(['0xb000']);

    // op-a's broadcaster still refuses op-b's Safe, and vice versa — the bound-Safe rejection
    // (finding E5) holds per-broadcaster even with two broadcasters live at once.
    await expect(
      executeSafeTransaction({} as never, {} as never, {
        safeAddress: OP_B_SAFE,
        to: ROUTER,
        value: 0n,
        data: '0xa111',
      }, opABroadcaster),
    ).rejects.toThrow(/mismatch|does not match/i);
    await expect(
      executeSafeTransaction({} as never, {} as never, {
        safeAddress: OP_A_SAFE,
        to: ROUTER,
        value: 0n,
        data: '0xb111',
      }, opBBroadcaster),
    ).rejects.toThrow(/mismatch|does not match/i);

    // op-a's own subsequent traffic is unaffected by op-b's broadcaster ever having existed.
    const opASecond = await executeSafeTransaction({} as never, {} as never, {
      safeAddress: OP_A_SAFE,
      to: ROUTER,
      value: 0n,
      data: '0xa222',
    }, opABroadcaster);
    expect(opASecond).toBe(`0x${'a1'.repeat(32)}`);
    expect(opASeen).toEqual(['0xa000', '0xa222']);
  });
});

describe('logicalTx derivation (finding E5 — load-bearing for the venue reconcile path)', () => {
  it('derives the same logicalTx for identical params — a retry adopts the same pending tx', async () => {
    const seen: string[] = [];
    const broadcaster = stubBroadcaster(async (input) => {
      seen.push(input.logicalTx);
      return { txHash: `0x${'e'.repeat(64)}` as const };
    });
    const params = { safeAddress: SAFE, to: ROUTER, value: 0n, data: '0xdeadbeef' as const };

    await executeSafeTransaction({} as never, {} as never, params, broadcaster);
    await executeSafeTransaction({} as never, {} as never, params, broadcaster);

    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
  });

  it('derives a different logicalTx when only the calldata differs — distinct operations never collide', async () => {
    const seen: string[] = [];
    const broadcaster = stubBroadcaster(async (input) => {
      seen.push(input.logicalTx);
      return { txHash: `0x${'f'.repeat(64)}` as const };
    });

    await executeSafeTransaction({} as never, {} as never, {
      safeAddress: SAFE,
      to: ROUTER,
      value: 0n,
      data: '0xaaaaaaaa',
    }, broadcaster);
    await executeSafeTransaction({} as never, {} as never, {
      safeAddress: SAFE,
      to: ROUTER,
      value: 0n,
      data: '0xbbbbbbbb',
    }, broadcaster);

    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  });
});
