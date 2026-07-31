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

  test("a hash change at the persisted cursor's height produces a reorg batch rolled back to the finalized checkpoint", async () => {
    const chain = buildScriptedChain();
    chain.mine(50);
    chain.setFinalized(40n);
    const s = source(chain, { startBlock: 0n });
    const first = await s.poll();
    chain.reorgFrom(first.cursor.blockNumber);
    const second = await s.poll();
    expect(second.reorg).toBeDefined();
    expect(second.reorg!.rolledBackTo.blockNumber).toBe(40n);
    expect(second.reorg!.orphanedBlockHashes.length).toBeGreaterThan(0);
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
});
