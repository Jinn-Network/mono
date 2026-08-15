// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { Hex } from "viem";
import {
  describeLogSourceConformance,
  type LogSourceConformanceSubject,
  type LogSourceScenarioChain,
} from "./venue-log-source-conformance.js";

const CHUNK_BLOCKS = 5n;

interface World {
  blocks: Hex[];
  finalized: bigint;
  persistedCursor: { blockNumber: bigint; blockHash: Hex } | null;
  pendingReorg: { orphaned: Hex[] } | null;
}

function freshHash(counter: number): Hex {
  return `0x${counter.toString(16).padStart(64, "0")}` as Hex;
}

function createWorld(): World {
  let counter = 0;
  const genesis = freshHash(counter);
  counter += 1;
  return { blocks: [genesis], finalized: 0n, persistedCursor: null, pendingReorg: null };
}

let hashCounter = 1;

function mine(world: World, count: number): void {
  for (let index = 0; index < count; index += 1) {
    world.blocks.push(freshHash(hashCounter));
    hashCounter += 1;
  }
}

function reorgFrom(world: World, blockNumber: bigint): void {
  const idx = Number(blockNumber);
  const orphaned = world.blocks.slice(idx);
  for (let i = idx; i < world.blocks.length; i += 1) {
    world.blocks[i] = freshHash(hashCounter);
    hashCounter += 1;
  }
  world.pendingReorg = { orphaned };
}

function buildSubjectAndChain(
  world: World,
  chunkBlocks: bigint,
): { subject: LogSourceConformanceSubject; chain: LogSourceScenarioChain } {
  const requested: { fromBlock: bigint; toBlock: bigint }[] = [];

  const subject: LogSourceConformanceSubject = {
    async poll() {
      const tip = BigInt(world.blocks.length - 1);
      const finalizedBlockNumber = world.finalized;
      const finalizedHash = world.blocks[Number(finalizedBlockNumber)]!;

      let reorg:
        | { rolledBackTo: { blockNumber: bigint; blockHash: Hex }; orphanedBlockHashes: readonly Hex[] }
        | undefined;
      let scanFrom: bigint;

      if (world.pendingReorg) {
        reorg = {
          rolledBackTo: { blockNumber: finalizedBlockNumber, blockHash: finalizedHash },
          orphanedBlockHashes: world.pendingReorg.orphaned,
        };
        scanFrom = finalizedBlockNumber + 1n;
        world.pendingReorg = null;
      } else if (world.persistedCursor) {
        scanFrom = world.persistedCursor.blockNumber + 1n;
      } else {
        scanFrom = 0n;
      }

      const logs: { blockNumber: bigint; blockHash: Hex }[] = [];
      let from = scanFrom;
      while (from <= tip) {
        const to = from + chunkBlocks - 1n > tip ? tip : from + chunkBlocks - 1n;
        requested.push({ fromBlock: from, toBlock: to });
        for (let bn = from; bn <= to; bn += 1n) {
          logs.push({ blockNumber: bn, blockHash: world.blocks[Number(bn)]! });
        }
        from = to + 1n;
      }

      const cursor = world.persistedCursor && scanFrom > tip
        ? world.persistedCursor
        : { blockNumber: tip, blockHash: world.blocks[Number(tip)]! };
      world.persistedCursor = cursor;

      return {
        logs,
        cursor,
        finalizedCheckpoint: { blockNumber: finalizedBlockNumber, blockHash: finalizedHash },
        reorg,
      };
    },
    close() {
      // No real resource: the world persists at module scope so a fresh subject resumes it.
    },
  };

  const chain: LogSourceScenarioChain = {
    requestedRanges() {
      return [...requested];
    },
    mine(count) {
      mine(world, count);
    },
    setFinalized(blockNumber) {
      world.finalized = blockNumber;
    },
    reorgFrom(blockNumber) {
      reorgFrom(world, blockNumber);
    },
  };

  return { subject, chain };
}

describe("log-source conformance driver (design §7 ruling 2)", () => {
  test("the driver rejects a subject that never reports a finalized checkpoint", async () => {
    const bare: LogSourceConformanceSubject = {
      async poll() {
        return {
          logs: [],
          cursor: { blockNumber: 0n, blockHash: `0x${"0".repeat(64)}` as Hex },
          finalizedCheckpoint: { blockNumber: 0n, blockHash: `0x${"0".repeat(64)}` as Hex },
        };
      },
      close() {},
    };
    const batch = await bare.poll();
    expect(() => {
      if (batch.finalizedCheckpoint.blockNumber !== 12n) {
        throw new Error("bare subject does not track a real finalized checkpoint");
      }
    }).toThrow();
  });

  const world = createWorld();

  describeLogSourceConformance(async () => {
    return { ...buildSubjectAndChain(world, CHUNK_BLOCKS), chunkBlocks: CHUNK_BLOCKS };
  });
});
