/**
 * Anvil-fork regression test for the per-EOA broadcast serializer (#792 / #525).
 *
 * Fires 4 concurrent transactions from ONE EOA, each wrapped in
 * `withEoaBroadcastLock(eoa, () => sendTx + waitReceipt)`, and asserts the
 * serializer produces strictly-increasing, contiguous nonces with no
 * "nonce too low" / "replacement transaction underpriced" collisions. Without
 * the lock these concurrent submits each read the same `pending` nonce and the
 * later ones revert — this test proves the lock closes that race on a real chain.
 *
 * Skipped automatically when ANVIL_RPC_URL is unset, so canary/CI never spawns
 * Anvil or red-gates on it.
 *
 * On-demand run:
 *   anvil --fork-url https://mainnet.base.org --port 8545 &
 *   ANVIL_RPC_URL=http://127.0.0.1:8545 \
 *     yarn vitest run test/tx-retry-eoa-serialization.anvil.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  createWalletClient,
  createPublicClient,
  http,
  parseEther,
  type Address,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { withEoaBroadcastLock } from '../src/tx-retry.js';

const ANVIL_RPC = process.env.ANVIL_RPC_URL;
const runOrSkip = ANVIL_RPC ? describe : describe.skip;

// Anvil's first pre-funded dev account (deterministic mnemonic). It is funded
// on both `anvil` default and `--fork-url` modes.
const ANVIL_KEY_0 =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;

runOrSkip('withEoaBroadcastLock — concurrent same-EOA submits (Anvil fork)', () => {
  it('serializes 4 concurrent submits into contiguous, gap-free nonces', async () => {
    const account = privateKeyToAccount(ANVIL_KEY_0);
    const transport = http(ANVIL_RPC);
    const walletClient = createWalletClient({ account, chain: base, transport });
    const publicClient = createPublicClient({ chain: base, transport });

    const from: Address = account.address;
    const startNonce = await publicClient.getTransactionCount({
      address: from,
      blockTag: 'pending',
    });

    // 4 cheap value self-sends. Each acquires the per-EOA lock, submits, and
    // waits for its receipt WHILE holding the lock — so the next submit only
    // reads `pending` after the prior tx is mined and the nonce has advanced.
    const CONCURRENCY = 4;
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_unused, i) =>
        withEoaBroadcastLock(from, async () => {
          const hash = await walletClient.sendTransaction({
            account,
            to: from,
            value: parseEther('0.0001'),
            chain: base,
          });
          const receipt = await publicClient.waitForTransactionReceipt({ hash });
          if (receipt.status !== 'success') {
            throw new Error(`tx ${i} reverted: ${hash}`);
          }
          const tx = await publicClient.getTransaction({ hash });
          return { hash, nonce: tx.nonce };
        }),
      ),
    );

    // (a) all 4 mined successfully (no rejection above means no nonce-too-low /
    //     replacement-underpriced surfaced).
    expect(results).toHaveLength(CONCURRENCY);

    // (c) the 4 mined nonces are strictly increasing and contiguous
    //     [n, n+1, n+2, n+3].
    const nonces = results.map((r) => r.nonce).sort((a, b) => a - b);
    expect(nonces).toEqual(
      Array.from({ length: CONCURRENCY }, (_unused, i) => startNonce + i),
    );

    // (b) distinct hashes — no accidental replacement of the same nonce.
    const hashes = new Set(results.map((r) => r.hash));
    expect(hashes.size).toBe(CONCURRENCY);
  }, 60_000);
});
