// SPDX-License-Identifier: MIT

// The chain half of the recovery scan (pinned 2026-07-24 design's "exact recovery scan"; supply
// design §8 D7): given a pending broadcast intent, ask the chain whether that exact post landed.
// Keyed on the two facts `TaskCreated` carries -- the indexed `creator` and the `taskCidDigest`
// word in the event data -- so an adopted match is the same pair the intent was claimed under,
// never a near-miss on one leg.
import type { Address, PublicClient } from "viem";
import { JINN_ROUTER_V3_ABI } from "../abis/jinn-router-v3.js";
import type { MarketplaceChainConfig } from "../addresses.js";
import type { PostingIntent, PostingOutcome, ScanForOnChainMatch } from "../broadcast-intent.js";

/** Blocks per `getLogs` window. Free Base endpoints cap the range (2k on several), so the scan windows. */
export const DEFAULT_SCAN_BLOCK_RANGE = 2_000n;

export interface AmbiguousMatchReport {
  readonly intent: PostingIntent;
  readonly adopted: PostingOutcome;
  readonly additionalMatches: number;
}

export interface OnChainMatchScanConfig {
  readonly chain: MarketplaceChainConfig;
  /** First block read -- the requester's first-post block, never an accidental 0n on mainnet. */
  readonly fromBlock: bigint;
  /** Last block read; omitted or "latest" asks the client for the head once per scan. */
  readonly toBlock?: bigint | "latest";
  readonly blockRange?: bigint;
  /**
   * Called when more than one on-chain post matches the same key. This store's WAL cannot produce
   * that (at-most-once per key), so it means a post was made outside it; the earliest match is
   * adopted and the caller is told, rather than the scan picking one quietly.
   */
  readonly onAmbiguousMatch?: (report: AmbiguousMatchReport) => void;
}

const TASK_CREATED_EVENT = (() => {
  const entry = JINN_ROUTER_V3_ABI.find((item) => item.type === "event" && item.name === "TaskCreated");
  if (entry === undefined) throw new Error("the JinnRouterV3 ABI is missing the TaskCreated event");
  return entry as Extract<(typeof JINN_ROUTER_V3_ABI)[number], { readonly type: "event"; readonly name: "TaskCreated" }>;
})();

interface Match extends PostingOutcome {
  readonly blockNumber: bigint;
  readonly logIndex: number;
}

/**
 * Builds the `ScanForOnChainMatch` port `recoverPostingIntents` calls. The viem client is a
 * parameter: this module never constructs a transport and never reads an RPC URL (custody law).
 */
export function scanForOnChainMatch(
  publicClient: PublicClient,
  config: OnChainMatchScanConfig,
): ScanForOnChainMatch {
  const window = config.blockRange ?? DEFAULT_SCAN_BLOCK_RANGE;
  if (window <= 0n) throw new RangeError("blockRange must be a positive block count");

  return async (intent) => {
    const wanted = `0x${intent.taskCidDigest.slice("sha256:".length)}`.toLowerCase();
    const head = config.toBlock === undefined || config.toBlock === "latest"
      ? await publicClient.getBlockNumber()
      : config.toBlock;

    const matches: Match[] = [];
    for (let from = config.fromBlock; from <= head; from += window) {
      const to = from + window - 1n > head ? head : from + window - 1n;
      // eslint-disable-next-line no-await-in-loop -- windows must be sequential: providers cap the range.
      const logs = await publicClient.getLogs({
        address: config.chain.jinnRouter as Address,
        event: TASK_CREATED_EVENT,
        args: { creator: intent.creatorSafe as Address },
        fromBlock: from,
        toBlock: to,
      });
      for (const entry of logs) {
        const digest = entry.args.taskCidDigest;
        const taskId = entry.args.taskId;
        if (digest === undefined || taskId === undefined) continue;
        if (digest.toLowerCase() !== wanted) continue;
        if (entry.transactionHash === null || entry.blockNumber === null || entry.logIndex === null) continue;
        matches.push({
          taskId,
          txHash: entry.transactionHash,
          blockNumber: entry.blockNumber,
          logIndex: entry.logIndex,
        });
      }
    }

    if (matches.length === 0) return null;
    matches.sort((left, right) => {
      if (left.blockNumber !== right.blockNumber) return left.blockNumber < right.blockNumber ? -1 : 1;
      return left.logIndex - right.logIndex;
    });
    const [earliest, ...rest] = matches as [Match, ...Match[]];
    const adopted: PostingOutcome = { taskId: earliest.taskId, txHash: earliest.txHash };
    if (rest.length > 0) {
      config.onAmbiguousMatch?.({ intent, adopted, additionalMatches: rest.length });
    }
    return adopted;
  };
}
