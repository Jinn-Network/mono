// SPDX-License-Identifier: MIT

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { JINN_ROUTER_V3_ABI, type PostingIntent, type ScanForOnChainMatch } from "@jinn-network/marketplace-binding";
import type { MarketplaceRawLog } from "@jinn-network/marketplace-projector";
import { encodeAbiParameters, encodeEventTopics, type Address, type Hex } from "viem";
import type { ChainLogSource, ChainLogCursor } from "../log-source/chain-log-source.js";
import { openVenueState, type VenueStateDatabase } from "../state/database.js";
import { createSqlitePostingIntentStore } from "./intent-store.js";
import { createOnChainPostingScan, drainPostingIntents } from "./drain.js";

const ROUTER = "0x1111111111111111111111111111111111111111" as Address;
const CREATOR_SAFE = `0x${"a".repeat(40)}` as `0x${string}`;
const TASK_DIGEST_HEX = "a".repeat(64);
const TASK_DIGEST = `sha256:${TASK_DIGEST_HEX}` as `sha256:${string}`;
const SUBMISSION_DIGEST = `sha256:${"b".repeat(64)}` as `sha256:${string}`;
const TX_HASH = `0x${"c".repeat(64)}` as Hex;
const BLOCK_HASH = `0x${"d".repeat(64)}` as Hex;

const TODAY_CHAIN = {
  chainId: 84532,
  taskCoordinator: "0x9999999999999999999999999999999999999999" as `0x${string}`,
  jinnRouter: ROUTER,
  mechMarketplace: "0x2222222222222222222222222222222222222222" as `0x${string}`,
  activityChecker: "0x3333333333333333333333333333333333333333" as `0x${string}`,
  generation: "today" as const,
};

function baseIntent(overrides: Partial<PostingIntent> = {}): PostingIntent {
  return {
    creatorSafe: CREATOR_SAFE,
    taskCidDigest: TASK_DIGEST,
    submissionDigest: SUBMISSION_DIGEST,
    idempotencyKey: "idem-1",
    createdAt: "2026-07-30T00:00:00.000Z",
    ...overrides,
  };
}

function exactTopics(topics: readonly (Hex | readonly Hex[] | null)[]): readonly Hex[] {
  return topics.map((topic) => {
    if (typeof topic !== "string") throw new TypeError("fixture topic must be a single encoded hex value");
    return topic;
  });
}

/** A `TaskCreated` (today-generation) log matching `CREATOR_SAFE` / `TASK_DIGEST_HEX` at `blockNumber`. */
function taskCreatedLog(input: { readonly blockNumber: bigint; readonly transactionHash?: Hex }): MarketplaceRawLog {
  const topics = encodeEventTopics({
    abi: JINN_ROUTER_V3_ABI,
    eventName: "TaskCreated",
    args: { creator: CREATOR_SAFE, taskId: 7n, manifestDigest: `0x${"9".repeat(64)}` as Hex },
  });
  const data = encodeAbiParameters(
    [
      { name: "taskCidDigest", type: "bytes32" },
      { name: "maxClaims", type: "uint32" },
      { name: "solutionBudget", type: "uint256" },
      { name: "verdictBudget", type: "uint256" },
    ],
    [`0x${TASK_DIGEST_HEX}` as Hex, 2, 100n, 20n],
  );
  return {
    chainId: TODAY_CHAIN.chainId,
    address: ROUTER,
    topics: exactTopics(topics),
    data,
    blockNumber: input.blockNumber,
    blockHash: BLOCK_HASH,
    transactionHash: input.transactionHash ?? TX_HASH,
    logIndex: 0,
    finalityTier: "safe",
  };
}

function stubLogSource(input: {
  readonly logs: readonly MarketplaceRawLog[];
  readonly cursor?: ChainLogCursor;
}): ChainLogSource {
  return {
    cursor: () => input.cursor,
    finalizedCheckpoint: () => undefined,
    orphanedBlockHashes: () => new Set(),
    async logsInRange(fromBlock, toBlock) {
      return input.logs.filter((log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock);
    },
    async poll() {
      throw new Error("drain never polls the log source directly");
    },
    close: () => undefined,
  };
}

let root: string;
let state: VenueStateDatabase;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "venue-posting-drain-"));
  state = openVenueState(join(root, "venue.db"));
});

afterEach(() => {
  state.close();
  rmSync(root, { recursive: true, force: true });
});

describe("drainPostingIntents (design §6.1 recovery scan)", () => {
  test("a TaskCreated-only match stays uncertain because it cannot prove the Submission", async () => {
    const store = createSqlitePostingIntentStore(state);
    const intent = baseIntent();
    const claim = await store.claim(intent);
    if (claim.kind !== "owner") throw new Error("expected owner");
    const match = { taskId: 7n, txHash: TX_HASH };
    const scan: ScanForOnChainMatch = async () => match;

    const stillUncertain = await drainPostingIntents({ store, scan });

    expect(stillUncertain).toEqual([intent]);
    expect(await store.scanPending()).toHaveLength(1);
    const record = await store.lookup(intent);
    expect(record?.resolved).toBeUndefined();

    // Idempotent: draining again with the same matching scan does not throw or re-resolve.
    await expect(drainPostingIntents({ store, scan })).resolves.toEqual([intent]);
  });

  test("a pending intent with no on-chain match stays pending and is returned to the caller, never silently retried", async () => {
    const store = createSqlitePostingIntentStore(state);
    const intent = baseIntent();
    await store.claim(intent);
    const scan: ScanForOnChainMatch = async () => null;

    const stillUncertain = await drainPostingIntents({ store, scan });

    expect(stillUncertain).toEqual([intent]);
    const pending = await store.scanPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.submissionDigest).toBe(intent.submissionDigest);
  });

  test("createOnChainPostingScan matches by (creatorSafe, taskCidDigest) against TaskCreated events in the scanned range", async () => {
    const logSource = stubLogSource({
      logs: [taskCreatedLog({ blockNumber: 950n })],
      cursor: { blockNumber: 1_000n, blockHash: BLOCK_HASH },
    });
    const scan = createOnChainPostingScan({ chain: TODAY_CHAIN, logSource, lookbackBlocks: 100n });

    const match = await scan(baseIntent());

    expect(match).toEqual({ taskId: 7n, txHash: TX_HASH });
  });

  test("createOnChainPostingScan returns null, not a throw, when the lookback window contains no match", async () => {
    const logSource = stubLogSource({
      // Same event, but far outside the small lookback window below.
      logs: [taskCreatedLog({ blockNumber: 500n })],
      cursor: { blockNumber: 1_000n, blockHash: BLOCK_HASH },
    });
    const scan = createOnChainPostingScan({ chain: TODAY_CHAIN, logSource, lookbackBlocks: 10n });

    await expect(scan(baseIntent())).resolves.toBeNull();
  });
});
