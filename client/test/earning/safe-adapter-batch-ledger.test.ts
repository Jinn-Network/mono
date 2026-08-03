/**
 * #525/#562/#897 (funds correctness): `executeSafeTxBatch` used to call
 * `safe.executeTransaction(signedTx)` with no ledger, no lock, and no pinned nonce -- relying on
 * the Safe SDK's internal viem client to auto-fill the transaction nonce from the `pending` count
 * (`executeSafeTxDirect`, its sibling in this same file, pins through `withNonceLedger`; batch did
 * not). Two concurrent batch calls against the SAME agent EOA (e.g. two bootstrap steps racing
 * under the shared master signer, or a manual `jinn bootstrap` racing the daemon's own bootstrap
 * loop) would both read the same pending nonce and collide.
 *
 * This test drives TWO concurrent `executeSafeTxBatch` calls against two independent
 * `SafeInstance` doubles (as two independently-`initDeployedSafe`'d instances would be) that
 * share one simulated on-chain nonce counter, and asserts the fix -- pinning + recording through
 * `withNonceLedger` -- gives them distinct, contiguous nonces with zero "nonce too low"
 * collisions.
 */
import { describe, expect, it, vi } from 'vitest';
import { executeSafeTxBatch, type SafeInstance } from '../../src/earning/safe-adapter.js';
import { createMemoryTxSubmissionLedger } from '../../src/tx-retry.js';

const FROM = '0x9999999999999999999999999999999999999999' as const;

function makeSimulatedSafeChain(startNonce: number) {
  let pending = startNonce;
  const usedNonces: number[] = [];
  let nonceTooLowCount = 0;

  const publicClient = {
    getChainId: vi.fn().mockResolvedValue(84532),
    getTransactionCount: vi.fn(async () => pending),
    estimateFeesPerGas: vi.fn().mockResolvedValue({
      maxFeePerGas: 100n,
      maxPriorityFeePerGas: 10n,
    }),
    getGasPrice: vi.fn(),
  };

  function makeSafe(): SafeInstance {
    return {
      getAddress: vi.fn(async () => FROM),
      isSafeDeployed: vi.fn(async () => true),
      createSafeDeploymentTransaction: vi.fn(),
      createTransaction: vi.fn(async () => ({})),
      signTransaction: vi.fn(async (tx: unknown) => tx),
      executeTransaction: vi.fn(async (_signedTx: unknown, options?: Record<string, unknown>) => {
        // Mirrors the real Safe SDK: when no nonce is pinned, it determines one via its own
        // internal `getTransactionCount({blockTag: 'pending'})` READ, then broadcasts as a
        // SEPARATE round-trip later -- exactly the two-step shape that lets two concurrent,
        // un-pinned callers both read the same pending value before either send lands. The
        // `setTimeout` (a real macrotask gap, not just a microtask hop) is what makes the race
        // reproduce reliably instead of accidentally self-serializing on microtask ordering.
        const nonce = (options?.['nonce'] as number | undefined)
          ?? await publicClient.getTransactionCount({ blockTag: 'pending' });
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (nonce < pending) {
          nonceTooLowCount += 1;
          throw new Error(`nonce too low: next nonce ${pending}, tx nonce ${nonce}`);
        }
        usedNonces.push(nonce);
        pending = nonce + 1;
        return { hash: `0x${nonce.toString(16).padStart(64, '0')}`, transactionResponse: undefined };
      }),
    } as unknown as SafeInstance;
  }

  return { publicClient, makeSafe, usedNonces, nonceTooLowCount: () => nonceTooLowCount };
}

describe('executeSafeTxBatch -- nonce ledger integration (issue #525/#562/#897)', () => {
  it('pins and records the nonce so two concurrent batches from the same EOA do not collide', async () => {
    const { publicClient, makeSafe, usedNonces, nonceTooLowCount } = makeSimulatedSafeChain(10);
    const ledger = createMemoryTxSubmissionLedger();

    const results = await Promise.all([
      executeSafeTxBatch(
        makeSafe(),
        [{ to: '0x1111111111111111111111111111111111111111', value: '0', data: '0x' }],
        { publicClient: publicClient as never, from: FROM, ledger },
      ),
      executeSafeTxBatch(
        makeSafe(),
        [{ to: '0x2222222222222222222222222222222222222222', value: '0', data: '0x' }],
        { publicClient: publicClient as never, from: FROM, ledger },
      ),
    ]);

    expect(results).toHaveLength(2);
    expect([...usedNonces].sort((a, b) => a - b)).toEqual([10, 11]);
    // Distinct hashes -- no accidental replacement of the same nonce.
    expect(new Set(usedNonces).size).toBe(2);
    // The core invariant: pinning + the shared per-EOA lock prevented the collision entirely.
    expect(nonceTooLowCount()).toBe(0);
  });
});
