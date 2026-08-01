// SPDX-License-Identifier: MIT

// The chain-side half of posting-intent recovery (design §6.1's "exact recovery scan"). The
// binding owns the recovery semantics (`recoverPostingIntents`: resolve on match, return
// still-uncertain intents untouched -- never re-broadcast); this package supplies only the
// chain read, matching a pending intent's `(creatorSafe, taskCidDigest)` against the router's
// `TaskCreated` history. Matching compares raw digest bytes: `intent.taskCidDigest` is a
// `sha256:<hex>` document digest (§6.1's posting key), never a CID string, so there is no CID
// decode on this path -- only a `0x`/`sha256:` prefix strip and a case-insensitive hex compare.
import {
  JINN_ROUTER_V3_ABI,
  recoverPostingIntents,
  type MarketplaceChainConfig,
  type PostingIntent,
  type PostingIntentStore,
  type PostingOutcome,
  type ScanForOnChainMatch,
} from "@jinn-network/marketplace-binding";
import { REVISED_COMMON_PROJECTOR_EVENTS_ABI } from "@jinn-network/marketplace-projector";
import { decodeEventLog, type Abi, type Address, type Hex } from "viem";
import type { ChainLogSource } from "../log-source/chain-log-source.js";

/** 50k blocks: the same generous default the settlement writer's Mech-deliver scan uses. */
export const DEFAULT_POSTING_SCAN_LOOKBACK_BLOCKS = 50_000n;

function taskCreatedEventAbi(chain: MarketplaceChainConfig): Abi {
  return chain.generation === "revised" ? REVISED_COMMON_PROJECTOR_EVENTS_ABI : JINN_ROUTER_V3_ABI;
}

/** Strips the `sha256:` document-digest prefix to a bare lowercase hex string (no `0x`). */
function bareDigestHex(digest: `sha256:${string}`): string {
  return digest.slice("sha256:".length).toLowerCase();
}

/**
 * The chain-side scan `drainPostingIntents` (and the binding's `recoverPostingIntents`) drives
 * for every still-pending intent: reads `TaskCreated` through the log source's chunked,
 * hash-verified range reader over the last `lookbackBlocks` (default
 * `DEFAULT_POSTING_SCAN_LOOKBACK_BLOCKS`) below the log source's own live cursor, and matches by
 * `(creator, taskCidDigest)`. No match in the window is `null` -- never a throw -- leaving the
 * intent uncertain for the caller to surface.
 */
export function createOnChainPostingScan(input: {
  readonly chain: MarketplaceChainConfig;
  readonly logSource: ChainLogSource;
  readonly lookbackBlocks?: bigint;
}): ScanForOnChainMatch {
  const lookback = input.lookbackBlocks ?? DEFAULT_POSTING_SCAN_LOOKBACK_BLOCKS;
  const abi = taskCreatedEventAbi(input.chain);

  return async (intent: PostingIntent): Promise<PostingOutcome | null> => {
    const latest = input.logSource.cursor()?.blockNumber ?? 0n;
    const fromBlock = latest > lookback ? latest - lookback : 0n;
    const logs = await input.logSource.logsInRange(fromBlock, latest);
    const wantCreator = intent.creatorSafe.toLowerCase();
    const wantDigest = bareDigestHex(intent.taskCidDigest);

    for (const log of logs) {
      try {
        const decoded = decodeEventLog({
          abi, data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: true,
        });
        if (decoded.eventName !== "TaskCreated") continue;
        const args = decoded.args as unknown as { creator: Address; taskCidDigest: Hex; taskId: bigint };
        if (args.creator.toLowerCase() !== wantCreator) continue;
        if (args.taskCidDigest.slice(2).toLowerCase() !== wantDigest) continue;
        return { taskId: args.taskId, txHash: log.transactionHash };
      } catch {
        // Not a TaskCreated event on this generation's ABI; the scanned range carries unrelated logs too.
      }
    }
    return null;
  };
}

/** Delegates to the binding's `recoverPostingIntents`; this package supplies only the chain-side `scan`. */
export async function drainPostingIntents(input: {
  readonly store: PostingIntentStore;
  readonly scan: ScanForOnChainMatch;
}): Promise<readonly PostingIntent[]> {
  return recoverPostingIntents(input.store, input.scan);
}
