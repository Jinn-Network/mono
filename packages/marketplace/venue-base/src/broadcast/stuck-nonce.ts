// SPDX-License-Identifier: MIT

// Stuck-nonce eviction, the relayer profile's fourth obligation (design §7 ruling 1). When the
// pending nonce runs ahead of the latest nonce and the ledger's own row at the lowest gap has
// been unresolved past the stale window, replace it with a zero-value self-send at that exact
// nonce so the sender unblocks. NOTE (plan finding 2): "eviction" here is stuck-nonce eviction,
// never OLAS service eviction -- the legacy re-stake-on-failure path was deliberately removed
// (#773) and is not reintroduced.
import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { bumpFees } from "./fees.js";
import type { SubmissionLedger } from "./ledger.js";

export interface EvictStuckNonceInput {
  readonly chainId: number;
  readonly from: Address;
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  readonly ledger: SubmissionLedger;
  readonly staleAfterMs: number;
  readonly nowMs: number;
}

export async function evictStuckNonce(
  input: EvictStuckNonceInput,
): Promise<{ readonly nonce: number; readonly recoveryTxHash: Hex } | undefined> {
  const [pending, latest] = await Promise.all([
    input.publicClient.getTransactionCount({ address: input.from, blockTag: "pending" }),
    input.publicClient.getTransactionCount({ address: input.from, blockTag: "latest" }),
  ]);
  if (pending <= latest) return undefined;

  for (const entry of input.ledger.unresolvedBetween(input.chainId, input.from, latest, pending)) {
    if (input.nowMs - entry.submittedAtMs < input.staleAfterMs) continue;
    const estimate = await input.publicClient.estimateFeesPerGas();
    const fees = bumpFees(
      {
        ...(estimate.maxFeePerGas === undefined ? {} : { maxFeePerGas: estimate.maxFeePerGas }),
        ...(estimate.maxPriorityFeePerGas === undefined
          ? {}
          : { maxPriorityFeePerGas: estimate.maxPriorityFeePerGas }),
      },
      entry.fees,
      1,
    );
    const account = input.walletClient.account;
    if (account === undefined) throw new Error("wallet client has no injected account");
    // `fees` (a `FeeSnapshot`) is statically `{maxFeePerGas?, maxPriorityFeePerGas?, gasPrice?}`,
    // but `bumpFees` only ever actually populates the legacy (`gasPrice`) OR EIP-1559
    // (`maxFeePerGas`+`maxPriorityFeePerGas`) shape, never both -- `SendTransactionParameters` is
    // a discriminated union over exactly that split, which the spread's wider static type can't
    // satisfy without this assertion.
    const recoveryTxHash = await input.walletClient.sendTransaction({
      account,
      chain: input.walletClient.chain ?? null,
      to: input.from,
      value: 0n,
      nonce: entry.nonce,
      ...fees,
    } as Parameters<typeof input.walletClient.sendTransaction>[0]);
    input.ledger.record({
      chainId: input.chainId,
      from: input.from,
      nonce: entry.nonce,
      txHash: recoveryTxHash,
      logicalTx: "stuck-nonce-recovery",
      to: input.from,
      value: 0n,
      fees,
      submittedAtMs: input.nowMs,
    });
    await input.publicClient.waitForTransactionReceipt({ hash: recoveryTxHash });
    input.ledger.markResolved(
      { chainId: input.chainId, from: input.from, nonce: entry.nonce },
      input.nowMs,
    );
    return { nonce: entry.nonce, recoveryTxHash };
  }
  return undefined;
}
