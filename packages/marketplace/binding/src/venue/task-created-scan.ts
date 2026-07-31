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

/**
 * Allowance between the requester's wall clock (`intent.createdAt`) and the block clock, before a
 * match is judged older than the intent. Fifteen minutes absorbs ordinary host drift without
 * re-opening the window a same-Task re-post lives in.
 */
export const DEFAULT_CLAIM_SKEW_SECONDS = 900n;

export interface AmbiguousMatchReport {
  readonly intent: PostingIntent;
  readonly adopted: PostingOutcome;
  readonly additionalMatches: number;
}

/** Matches that were dropped because they were mined before the intent was claimed (F-C5-7). */
export interface StaleMatchReport {
  readonly intent: PostingIntent;
  readonly skipped: number;
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
  /** Clock-skew allowance for the claim-time lower bound; omitted -> `DEFAULT_CLAIM_SKEW_SECONDS`. */
  readonly claimSkewSeconds?: bigint;
  /** Called when matches were found but every one predates the intent's claim time (F-C5-7). */
  readonly onStaleMatch?: (report: StaleMatchReport) => void;
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

/** The intent's claim time in whole seconds, or undefined when `createdAt` is not a parsable instant. */
function claimedAtSeconds(intent: PostingIntent): bigint | undefined {
  const parsed = Date.parse(intent.createdAt);
  return Number.isNaN(parsed) ? undefined : BigInt(Math.floor(parsed / 1000));
}

/**
 * Builds the `ScanForOnChainMatch` port `recoverPostingIntents` calls. The viem client is a
 * parameter: this module never constructs a transport and never reads an RPC URL (custody law).
 *
 * A match must be at least as new as the intent that is looking for it (finding F-C5-7).
 * `TaskCreated` carries no submission digest, so the key this scan can check on-chain is two of
 * the intent's three legs; a requester re-posting the same Task under a second Submission would
 * otherwise have the FIRST post adopted for the second intent -- one match, no ambiguity report,
 * a taskId belonging to a different Submission, and a post that never happens. Bounding the scan
 * below by the claim time (minus a skew allowance) is what the requester already knows at claim
 * time and costs one `getBlock` per candidate.
 */
export function scanForOnChainMatch(
  publicClient: PublicClient,
  config: OnChainMatchScanConfig,
): ScanForOnChainMatch {
  const window = config.blockRange ?? DEFAULT_SCAN_BLOCK_RANGE;
  if (window <= 0n) throw new RangeError("blockRange must be a positive block count");
  const skew = config.claimSkewSeconds ?? DEFAULT_CLAIM_SKEW_SECONDS;
  if (skew < 0n) throw new RangeError("claimSkewSeconds must not be negative");

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

    // The claim-time lower bound. An unparsable `createdAt` leaves the bound off rather than
    // stranding a recoverable intent -- the store never writes one, so this is a foreign-record case.
    const floor = claimedAtSeconds(intent);
    if (floor !== undefined) {
      const timestamps = new Map<bigint, bigint>();
      const fresh: Match[] = [];
      for (const candidate of matches) {
        if (!timestamps.has(candidate.blockNumber)) {
          // eslint-disable-next-line no-await-in-loop -- candidates are rare (usually one).
          const block = await publicClient.getBlock({ blockNumber: candidate.blockNumber });
          timestamps.set(candidate.blockNumber, block.timestamp);
        }
        if ((timestamps.get(candidate.blockNumber) ?? 0n) + skew >= floor) fresh.push(candidate);
      }
      if (fresh.length !== matches.length) {
        config.onStaleMatch?.({ intent, skipped: matches.length - fresh.length });
      }
      if (fresh.length === 0) return null;
      matches.length = 0;
      matches.push(...fresh);
    }

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
