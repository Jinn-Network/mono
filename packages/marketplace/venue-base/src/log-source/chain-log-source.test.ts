// SPDX-License-Identifier: MIT

// A scripted, in-memory `PublicClient` double drives every obligation of the chunked,
// hash-verified log source (design §7 ruling 2): chunk cap, tiling, dual finality marks, reorg
// rollback, checkpoint monotonicity, the stale-`finalized`-tag fallback, and resumability. No
// network, no real chain -- just a mutable block list this file controls directly.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Address, Hex, PublicClient } from "viem";
import { BASE_SEPOLIA_TODAY } from "@jinn-network/marketplace-binding";
import { decodeMarketplaceLogs, marketplaceEventOriginAuthority } from "@jinn-network/marketplace-projector";
import { openVenueState, type VenueStateDatabase } from "../state/database.js";
import {
  createChainLogSource,
  type ChainLogSourceOptions,
} from "./chain-log-source.js";

interface ScriptedBlockLog {
  readonly address: Address;
  readonly topics: readonly Hex[];
  readonly data: Hex;
  readonly transactionHash: Hex;
  readonly logIndex: number;
}

interface ScriptedChain {
  readonly publicClient: PublicClient;
  mine(count: number): void;
  setFinalized(blockNumber: bigint): void;
  reorgFrom(blockNumber: bigint): void;
  addLog(blockNumber: bigint, log: ScriptedBlockLog): void;
  requestedRanges(): readonly { readonly fromBlock: bigint; readonly toBlock: bigint }[];
  blockHashAt(blockNumber: bigint): Hex;
  latestBlockNumber(): bigint;
}

function buildScriptedChain(): ScriptedChain {
  const blocks: Hex[] = [];
  let finalizedOverride: bigint | undefined;
  let hashSeed = 0;
  const logsByBlock = new Map<number, ScriptedBlockLog[]>();
  const ranges: { fromBlock: bigint; toBlock: bigint }[] = [];

  function freshHash(): Hex {
    hashSeed += 1;
    return `0x${hashSeed.toString(16).padStart(64, "0")}` as Hex;
  }

  function mine(count: number): void {
    for (let index = 0; index < count; index += 1) blocks.push(freshHash());
  }
  mine(1); // genesis (block 0)

  const publicClient = {
    async getBlock(
      args: { readonly blockTag?: "latest" | "finalized"; readonly blockNumber?: bigint } = {},
    ) {
      if (args.blockNumber !== undefined) {
        const number = args.blockNumber;
        const hash = blocks[Number(number)];
        if (hash === undefined) throw new Error(`scripted chain: no block ${number}`);
        return { number, hash };
      }
      if (args.blockTag === "finalized") {
        const number = finalizedOverride ?? BigInt(blocks.length - 1);
        return { number, hash: blocks[Number(number)]! };
      }
      const number = BigInt(blocks.length - 1);
      return { number, hash: blocks[Number(number)]! };
    },
    async getLogs(
      args: { readonly address: readonly Address[]; readonly fromBlock: bigint; readonly toBlock: bigint },
    ) {
      ranges.push({ fromBlock: args.fromBlock, toBlock: args.toBlock });
      const result: unknown[] = [];
      for (let n = args.fromBlock; n <= args.toBlock; n += 1n) {
        const entries = logsByBlock.get(Number(n)) ?? [];
        for (const entry of entries) {
          result.push({
            address: entry.address,
            topics: entry.topics,
            data: entry.data,
            blockHash: blocks[Number(n)],
            blockNumber: n,
            transactionHash: entry.transactionHash,
            transactionIndex: 0,
            logIndex: entry.logIndex,
            removed: false,
          });
        }
      }
      return result;
    },
  } as unknown as PublicClient;

  return {
    publicClient,
    mine,
    setFinalized(blockNumber) { finalizedOverride = blockNumber; },
    reorgFrom(blockNumber) {
      for (let index = Number(blockNumber); index < blocks.length; index += 1) blocks[index] = freshHash();
    },
    addLog(blockNumber, log) {
      const key = Number(blockNumber);
      const existing = logsByBlock.get(key) ?? [];
      existing.push(log);
      logsByBlock.set(key, existing);
    },
    requestedRanges: () => [...ranges],
    blockHashAt: (blockNumber) => blocks[Number(blockNumber)]!,
    latestBlockNumber: () => BigInt(blocks.length - 1),
  };
}

let root: string;
let state: VenueStateDatabase;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "venue-log-source-"));
  state = openVenueState(join(root, "venue.db"));
});
afterEach(() => { state.close(); rmSync(root, { recursive: true, force: true }); });

function source(chain: ScriptedChain, options?: ChainLogSourceOptions, db: VenueStateDatabase = state) {
  return createChainLogSource({
    chain: BASE_SEPOLIA_TODAY,
    publicClient: chain.publicClient,
    state: db,
    addresses: [BASE_SEPOLIA_TODAY.jinnRouter],
    options,
  });
}

describe("chain log source (design §7 ruling 2)", () => {
  test("the first poll starts at options.startBlock", async () => {
    const chain = buildScriptedChain();
    chain.mine(50);
    chain.setFinalized(40n);
    await source(chain, { startBlock: 30n }).poll();
    const min = chain.requestedRanges().reduce(
      (acc, range) => (range.fromBlock < acc ? range.fromBlock : acc),
      chain.requestedRanges()[0]!.fromBlock,
    );
    expect(min).toBe(30n);
  });

  test("no requested range exceeds chunkBlocks", async () => {
    const chain = buildScriptedChain();
    chain.mine(35);
    chain.setFinalized(30n);
    await source(chain, { startBlock: 0n, chunkBlocks: 10n }).poll();
    for (const range of chain.requestedRanges()) {
      expect(range.toBlock - range.fromBlock + 1n).toBeLessThanOrEqual(10n);
    }
  });

  test("requested ranges tile the scanned span exactly once, with no gap and no overlap", async () => {
    const chain = buildScriptedChain();
    chain.mine(35);
    chain.setFinalized(30n);
    await source(chain, { startBlock: 0n, chunkBlocks: 10n }).poll();
    const ranges = [...chain.requestedRanges()].sort((a, b) => (a.fromBlock < b.fromBlock ? -1 : 1));
    expect(ranges[0]!.fromBlock).toBe(0n);
    for (let index = 1; index < ranges.length; index += 1) {
      expect(ranges[index]!.fromBlock).toBe(ranges[index - 1]!.toBlock + 1n);
    }
    expect(ranges.at(-1)!.toBlock).toBe(chain.latestBlockNumber());
  });

  test("every emitted log carries chainId, finalityTier, blockHash, transactionHash and logIndex", async () => {
    const chain = buildScriptedChain();
    chain.mine(20);
    chain.setFinalized(15n);
    const txHash = `0x${"a".repeat(64)}` as Hex;
    chain.addLog(5n, {
      address: BASE_SEPOLIA_TODAY.jinnRouter,
      topics: [`0x${"b".repeat(64)}` as Hex],
      data: "0x" as Hex,
      transactionHash: txHash,
      logIndex: 0,
    });
    const batch = await source(chain, { startBlock: 0n }).poll();
    expect(batch.logs).toHaveLength(1);
    const log = batch.logs[0]!;
    expect(log.chainId).toBe(BASE_SEPOLIA_TODAY.chainId);
    expect(log.finalityTier).toBeDefined();
    expect(log.blockHash).toBe(chain.blockHashAt(5n));
    expect(log.transactionHash).toBe(txHash);
    expect(log.logIndex).toBe(0);
  });

  test("logs at or below the finalized head carry finalityTier finalized; later ones carry safe", async () => {
    const chain = buildScriptedChain();
    chain.mine(20);
    chain.setFinalized(10n);
    chain.addLog(10n, {
      address: BASE_SEPOLIA_TODAY.jinnRouter,
      topics: [`0x${"c".repeat(64)}` as Hex],
      data: "0x" as Hex,
      transactionHash: `0x${"1".repeat(64)}` as Hex,
      logIndex: 0,
    });
    chain.addLog(11n, {
      address: BASE_SEPOLIA_TODAY.jinnRouter,
      topics: [`0x${"d".repeat(64)}` as Hex],
      data: "0x" as Hex,
      transactionHash: `0x${"2".repeat(64)}` as Hex,
      logIndex: 0,
    });
    const batch = await source(chain, { startBlock: 0n }).poll();
    const atFinalized = batch.logs.find((log) => log.blockNumber === 10n);
    const aboveFinalized = batch.logs.find((log) => log.blockNumber === 11n);
    expect(atFinalized?.finalityTier).toBe("finalized");
    expect(aboveFinalized?.finalityTier).toBe("safe");
  });

  test("the live cursor advances to latest; the durable checkpoint only to finalized", async () => {
    const chain = buildScriptedChain();
    chain.mine(50);
    chain.setFinalized(40n);
    const batch = await source(chain, { startBlock: 0n }).poll();
    expect(batch.cursor.blockNumber).toBe(chain.latestBlockNumber());
    expect(batch.finalizedCheckpoint.blockNumber).toBe(40n);
  });

  test("a reorg enumerates the complete displaced suffix (including empty blocks) from its canonical rebuild boundary", async () => {
    const chain = buildScriptedChain();
    chain.mine(50);
    chain.setFinalized(40n);
    const s = source(chain, { startBlock: 0n });
    const first = await s.poll();
    // The old chain at 41..50 contained no marketplace log. Their hashes must nevertheless be
    // retained before the replacement fork becomes visible to the RPC.
    chain.reorgFrom(45n);
    const second = await s.poll();
    expect(second.reorg).toBeDefined();
    expect(second.reorg!.rolledBackTo.blockNumber).toBe(40n);
    expect(second.reorg!.canonicalRebuildBoundary).toEqual(second.reorg!.rolledBackTo);
    expect(second.reorg!.displacedBlocks.map((block) => block.blockNumber)).toEqual([
      45n, 46n, 47n, 48n, 49n, 50n,
    ]);
    expect(second.reorg!.orphanedBlockHashes).toEqual(
      second.reorg!.displacedBlocks.map((block) => block.blockHash),
    );
  });

  test("the rescan after a reorg re-requests every block above the checkpoint", async () => {
    const chain = buildScriptedChain();
    chain.mine(50);
    chain.setFinalized(40n);
    const s = source(chain, { startBlock: 0n });
    const first = await s.poll();
    const beforeCount = chain.requestedRanges().length;
    chain.reorgFrom(first.cursor.blockNumber);
    const second = await s.poll();
    const newRanges = chain.requestedRanges().slice(beforeCount);
    expect(newRanges.length).toBeGreaterThan(0);
    const min = newRanges.reduce((acc, range) => (range.fromBlock < acc ? range.fromBlock : acc), newRanges[0]!.fromBlock);
    expect(min).toBe(second.reorg!.rolledBackTo.blockNumber + 1n);
  });

  test("a reorg never rolls the checkpoint backwards", async () => {
    const chain = buildScriptedChain();
    chain.mine(50);
    chain.setFinalized(30n);
    const s = source(chain, { startBlock: 0n });
    const first = await s.poll();
    expect(first.finalizedCheckpoint.blockNumber).toBe(30n);
    // A provider regressing its `finalized` tag, combined with a reorg at the cursor height.
    chain.setFinalized(20n);
    chain.reorgFrom(first.cursor.blockNumber);
    const second = await s.poll();
    expect(second.reorg).toBeDefined();
    expect(second.reorg!.rolledBackTo.blockNumber).toBe(30n);
    expect(second.finalizedCheckpoint.blockNumber).toBe(30n);
  });

  test("a provider serving a stale finalized tag (finalized == latest) falls back to latest - finalityDepthFallback", async () => {
    const chain = buildScriptedChain();
    chain.mine(60); // finalizedOverride left unset -> "finalized" reads as latest (stale)
    const batch = await source(chain, { startBlock: 0n, finalityDepthFallback: 5n }).poll();
    expect(batch.finalizedCheckpoint.blockNumber).toBe(chain.latestBlockNumber() - 5n);
  });

  test("a finalized tag stuck far behind latest (anvil-fork shape) also falls back to depth", async () => {
    // Anvil forks leave `finalized` pinned at the fork point while `latest` advances with
    // every `evm_mine`. Without the depth floor, claims mined after the fork never finalize.
    const chain = buildScriptedChain();
    chain.mine(10);
    chain.setFinalized(2n);
    chain.mine(50); // latest=60, finalized stuck at 2, depth=5 → lag 58 > 5
    const batch = await source(chain, { startBlock: 0n, finalityDepthFallback: 5n }).poll();
    expect(batch.finalizedCheckpoint.blockNumber).toBe(chain.latestBlockNumber() - 5n);
  });

  test("a second source over the same state file resumes at the persisted cursor without re-scanning", async () => {
    const chain = buildScriptedChain();
    chain.mine(50);
    chain.setFinalized(40n);
    const first = await source(chain, { startBlock: 0n }).poll();
    const scannedBefore = chain.requestedRanges().length;
    chain.mine(5);
    const second = await source(chain, { startBlock: 0n }).poll();
    expect(second.cursor.blockNumber).toBe(chain.latestBlockNumber());
    const newRanges = chain.requestedRanges().slice(scannedBefore);
    expect(newRanges.length).toBeGreaterThan(0);
    for (const range of newRanges) {
      expect(range.fromBlock).toBeGreaterThan(first.cursor.blockNumber);
    }
  });

  test("the batch shape matches what the projector's decoder consumes", async () => {
    const chain = buildScriptedChain();
    chain.mine(10);
    chain.setFinalized(5n);
    const { logs } = await source(chain, { startBlock: 0n }).poll();
    const events = decodeMarketplaceLogs(logs, marketplaceEventOriginAuthority(BASE_SEPOLIA_TODAY, () => true));
    expect(Array.isArray(events)).toBe(true);
  });

  // ---------------------------------------------------------------------------------------------
  // Idle-gap catch-up (#2552): a cursor that fell days/100k blocks behind must reach head in
  // bounded work. The immutable region at/below `finalized` is never per-block hash-scanned; only
  // the unfinalized tail is. Catch-up is O(unfinalized tail), not O(idle gap), and the finalized
  // jump is persisted so a transient tail-scan error resumes rather than restarting from stale.
  // ---------------------------------------------------------------------------------------------

  /** Counts `getBlock({ blockNumber })` (the per-block hash scan) and can fail it once, at a height. */
  function countingHashReads(chain: ScriptedChain): {
    readonly publicClient: PublicClient;
    blockNumberReads(): number;
    failNextHashAt(blockNumber: bigint): void;
  } {
    let reads = 0;
    let failAt: bigint | undefined;
    const inner = chain.publicClient as unknown as {
      getBlock: (args?: { blockTag?: "latest" | "finalized"; blockNumber?: bigint }) => Promise<unknown>;
      getLogs: (args: unknown) => Promise<unknown>;
    };
    const publicClient = {
      async getBlock(args: { blockTag?: "latest" | "finalized"; blockNumber?: bigint } = {}) {
        if (args.blockNumber !== undefined) {
          reads += 1;
          if (failAt !== undefined && args.blockNumber === failAt) {
            failAt = undefined;
            throw new Error(`transient RPC error at block ${args.blockNumber}`);
          }
        }
        return inner.getBlock(args);
      },
      getLogs: (args: unknown) => inner.getLogs(args),
    } as unknown as PublicClient;
    return {
      publicClient,
      blockNumberReads: () => reads,
      failNextHashAt: (blockNumber) => { failAt = blockNumber; },
    };
  }

  test("catch-up over a >10k-block idle gap is O(unfinalized tail), not O(gap), in per-block hash reads", async () => {
    const chain = buildScriptedChain();
    // Establish a persisted cursor near block 50.
    chain.mine(50);
    chain.setFinalized(40n);
    const instrument = countingHashReads(chain);
    const s = createChainLogSource({
      chain: BASE_SEPOLIA_TODAY,
      publicClient: instrument.publicClient,
      state,
      addresses: [BASE_SEPOLIA_TODAY.jinnRouter],
      options: { startBlock: 0n },
    });
    await s.poll();
    expect(s.cursor()!.blockNumber).toBe(50n);

    // Now open a ~12,000-block idle gap: latest jumps to 12,050, finalized to 12,000.
    chain.mine(12_000); // latest = 12,050
    chain.setFinalized(12_000n);
    const gap = 12_000n - 50n; // finalized - persisted.live
    const tail = 12_050n - 12_000n; // latest - finalized

    const readsBefore = instrument.blockNumberReads();
    const catchUp = await s.poll();
    // The catch-up poll advances the cursor straight to the immutable finalized boundary...
    expect(catchUp.cursor.blockNumber).toBe(12_000n);
    expect(catchUp.finalizedCheckpoint.blockNumber).toBe(12_000n);
    // ...without per-block hash-scanning the ~12k immutable region. A handful of reads at most
    // (the single reorg-check read of the old cursor), never anything close to the gap.
    const catchUpReads = instrument.blockNumberReads() - readsBefore;
    expect(catchUpReads).toBeLessThan(10);
    expect(catchUpReads).toBeLessThan(Number(gap));

    // The next poll scans the bounded unfinalized tail and reaches latest.
    const readsBeforeTail = instrument.blockNumberReads();
    const tailPoll = await s.poll();
    expect(tailPoll.cursor.blockNumber).toBe(12_050n);
    const tailReads = instrument.blockNumberReads() - readsBeforeTail;
    // Bounded by the tail (plus the one reorg-check read), never by the idle gap.
    expect(BigInt(tailReads)).toBeLessThanOrEqual(tail + 2n);
    expect(tailReads).toBeLessThan(Number(gap));
  });

  test("the catch-up jump still INGESTS marketplace logs from the skipped immutable region (logs not dropped)", async () => {
    // The catch-up jump skips per-block HASH sampling of `(persisted.live, finalized]`, but the
    // region's marketplace LOGS are the operator's idle-window events and must still be returned.
    // A mutation that makes the jump return `[]` (no-op its getLogs) must redden this test.
    const chain = buildScriptedChain();
    chain.mine(50);
    chain.setFinalized(40n);
    const s = source(chain, { startBlock: 0n });
    await s.poll();
    expect(s.cursor()!.blockNumber).toBe(50n);

    // Open a >chunk-sized idle gap and place a marketplace log at a block BELOW finalized,
    // inside the region the jump skips for hash sampling.
    chain.mine(12_000); // latest = 12,050
    chain.setFinalized(12_000n); // finalized - live = 11,950 > chunk (1000) → catch-up jump
    const idleWindowTx = `0x${"e".repeat(64)}` as Hex;
    chain.addLog(6_000n, {
      address: BASE_SEPOLIA_TODAY.jinnRouter,
      topics: [`0x${"f".repeat(64)}` as Hex],
      data: "0x" as Hex,
      transactionHash: idleWindowTx,
      logIndex: 0,
    });

    const catchUp = await s.poll();
    expect(catchUp.cursor.blockNumber).toBe(12_000n); // took the jump path
    const ingested = catchUp.logs.find((log) => log.blockNumber === 6_000n);
    expect(ingested).toBeDefined();
    expect(ingested!.transactionHash).toBe(idleWindowTx);
    // The whole skipped region is at/below finalized, so the event is tagged `finalized`.
    expect(ingested!.finalityTier).toBe("finalized");
  });

  test("a transient hash-read error during catch-up loses no progress: the next poll resumes past the immutable region", async () => {
    const chain = buildScriptedChain();
    chain.mine(50);
    chain.setFinalized(40n);
    const instrument = countingHashReads(chain);
    const s = createChainLogSource({
      chain: BASE_SEPOLIA_TODAY,
      publicClient: instrument.publicClient,
      state,
      addresses: [BASE_SEPOLIA_TODAY.jinnRouter],
      options: { startBlock: 0n },
    });
    await s.poll();
    expect(s.cursor()!.blockNumber).toBe(50n);

    chain.mine(12_000); // latest = 12,050
    chain.setFinalized(12_000n);

    // First poll takes the catch-up fast path and durably persists the jump to finalized.
    await s.poll();
    expect(s.cursor()!.blockNumber).toBe(12_000n);

    // The tail scan then hits a transient error partway through.
    instrument.failNextHashAt(12_030n);
    await expect(s.poll()).rejects.toThrow(/transient RPC error/u);

    // Progress is NOT lost: the cursor is still at the finalized jump (12,000), well past the
    // original stale cursor (50). A pre-#2552 build would have thrown from the O(gap) scan and
    // left the cursor at 50 forever — the live wedge.
    expect(s.cursor()!.blockNumber).toBe(12_000n);

    // A subsequent poll (no injected error) resumes from 12,000 and reaches head.
    const resumed = await s.poll();
    expect(resumed.cursor.blockNumber).toBe(12_050n);
  });

  test("a reorg in the unfinalized tail after a catch-up jump is still detected exactly as normal", async () => {
    const chain = buildScriptedChain();
    chain.mine(50);
    chain.setFinalized(40n);
    const s = source(chain, { startBlock: 0n });
    await s.poll();

    chain.mine(12_000); // latest = 12,050
    chain.setFinalized(12_000n);
    await s.poll(); // catch-up jump to 12,000
    const tail = await s.poll(); // scans + advances to 12,050
    expect(tail.cursor.blockNumber).toBe(12_050n);

    // Reorg inside the unfinalized tail (above the finalized checkpoint at 12,000).
    chain.reorgFrom(12_040n);
    const reorged = await s.poll();
    expect(reorged.reorg).toBeDefined();
    expect(reorged.reorg!.rolledBackTo.blockNumber).toBe(12_000n);
    expect(reorged.reorg!.displacedBlocks.map((b) => b.blockNumber)).toEqual([
      12_040n, 12_041n, 12_042n, 12_043n, 12_044n, 12_045n,
      12_046n, 12_047n, 12_048n, 12_049n, 12_050n,
    ]);
    expect(reorged.reorg!.orphanedBlockHashes.length).toBe(11);
  });

  test("the catch-up jump prunes scanned hashes through the advanced finalized checkpoint", async () => {
    const chain = buildScriptedChain();
    chain.mine(50);
    chain.setFinalized(40n);
    const s = source(chain, { startBlock: 0n });
    await s.poll();
    const scannedBelow = (boundary: number): number => (state.db
      .prepare("SELECT COUNT(*) AS n FROM scanned_block_hashes WHERE block_number < ?")
      .get(boundary) as { n: number }).n;
    // After the first poll, blocks 41..50 (above the finalized checkpoint 40) are retained.
    expect(scannedBelow(51)).toBeGreaterThan(0);

    chain.mine(12_000); // latest = 12,050
    chain.setFinalized(12_000n);
    const catchUp = await s.poll();
    expect(catchUp.finalizedCheckpoint.blockNumber).toBe(12_000n);
    // pruneThroughFinalized ran through the ADVANCED checkpoint: nothing below 12,000 remains.
    expect(scannedBelow(12_000)).toBe(0);
  });

  test("a below-threshold gap that still straddles finalized keeps the pre-#2552 single-poll behavior", async () => {
    // persisted.live is below finalized but by less than a chunk, so the steady-state branch (not
    // the catch-up jump) runs: one poll advances straight to latest and hash-scans the tail.
    const chain = buildScriptedChain();
    chain.mine(50);
    chain.setFinalized(40n);
    const s = source(chain, { startBlock: 0n });
    await s.poll(); // cursor = 50
    chain.mine(60); // latest = 110
    chain.setFinalized(100n); // finalized - live = 100 - 50 = 50 < chunk (1000)
    const batch = await s.poll();
    expect(batch.cursor.blockNumber).toBe(110n); // reached latest in ONE poll
    expect(batch.finalizedCheckpoint.blockNumber).toBe(100n);
  });
});
