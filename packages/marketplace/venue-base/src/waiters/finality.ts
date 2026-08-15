// SPDX-License-Identifier: MIT

// A real waiter over the log source applying the projector's finality policy (design §6.1). The
// policy is not re-derived here: `finalityPolicy` is the single owner of "decision-grade compute
// remains finalized-gated", and this waiter's only job is to decide, honestly, whether the claim
// fact has reached that tier -- or was reorged out from under it.
import type { FinalityAwaitResult, FinalityPort } from "@jinn-network/marketplace-binding";
import { finalityPolicy } from "@jinn-network/marketplace-projector";
import type { Hex, PublicClient } from "viem";
import type { ChainLogSource } from "../log-source/chain-log-source.js";

export interface FinalityWaiterOptions {
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_FINALITY_POLL_INTERVAL_MS = 4_000;
export const DEFAULT_FINALITY_TIMEOUT_MS = 900_000;

export function createFinalityWaiter(input: {
  readonly publicClient: PublicClient;
  readonly logSource: ChainLogSource;
  readonly options?: FinalityWaiterOptions;
}): FinalityPort {
  const options = input.options ?? {};
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_FINALITY_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_FINALITY_TIMEOUT_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  async function claimBlock(
    claimTxHash: Hex,
  ): Promise<{ readonly blockNumber: bigint; readonly blockHash: Hex } | "failed" | "missing"> {
    try {
      const receipt = await input.publicClient.getTransactionReceipt({ hash: claimTxHash });
      if (receipt.status !== "success") return "failed";
      return { blockNumber: receipt.blockNumber, blockHash: receipt.blockHash };
    } catch {
      return "missing";
    }
  }

  return {
    async awaitFinalized({ claimTxHash }): Promise<FinalityAwaitResult> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const block = await claimBlock(claimTxHash);
        if (block === "failed") return { ok: false, kind: "failed" };
        if (block !== "missing") {
          if (input.logSource.orphanedBlockHashes().has(block.blockHash.toLowerCase())) {
            return { ok: false, kind: "reorged" };
          }
          const checkpoint = input.logSource.finalizedCheckpoint();
          if (checkpoint !== undefined && checkpoint.blockNumber >= block.blockNumber) {
            const canonical = await input.publicClient.getBlock({ blockNumber: block.blockNumber });
            if ((canonical.hash ?? "").toLowerCase() !== block.blockHash.toLowerCase()) {
              return { ok: false, kind: "reorged" };
            }
            // The tier is now `finalized`; the policy is the authority on what that permits.
            return finalityPolicy({ finalityTier: "finalized" }).gateExecution
              ? { ok: true }
              : { ok: false, kind: "failed" };
          }
        }
        if (Date.now() >= deadline) return { ok: false, kind: "failed" };
        await sleep(pollIntervalMs);
        await input.logSource.poll();
      }
    },
  };
}
