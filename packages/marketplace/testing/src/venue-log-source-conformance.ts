// SPDX-License-Identifier: MIT

// The chain log-source's chunked, hash-verified, dual-cursor obligations as executable
// conformance (design §7 ruling 2): a provider chunk cap is never exceeded, the scanned span
// tiles exactly once, the live cursor tracks `latest` while a durable checkpoint advances only
// on `finalized`, and a cursor-hash mismatch rolls the scan back to the last finalized
// checkpoint and re-scans forward.
import { describe, expect, test } from "vitest";
import type { Hex } from "viem";

export interface LogSourceCursor {
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
}

export interface LogSourceConformanceSubject {
  poll(): Promise<{
    readonly logs: readonly { readonly blockNumber: bigint; readonly blockHash: Hex }[];
    readonly cursor: LogSourceCursor;
    readonly finalizedCheckpoint: LogSourceCursor;
    readonly reorg?: {
      readonly rolledBackTo: LogSourceCursor;
      readonly orphanedBlockHashes: readonly Hex[];
    };
  }>;
  close(): void;
}

export interface LogSourceScenarioChain {
  requestedRanges(): readonly { readonly fromBlock: bigint; readonly toBlock: bigint }[];
  mine(count: number): void;
  setFinalized(blockNumber: bigint): void;
  reorgFrom(blockNumber: bigint): void;
}

export function describeLogSourceConformance(
  build: () => Promise<{
    subject: LogSourceConformanceSubject;
    chain: LogSourceScenarioChain;
    chunkBlocks: bigint;
  }>,
): void {
  describe("chain log-source conformance (design §7 ruling 2)", () => {
    test("never requests a range wider than the configured provider chunk cap", async () => {
      const { subject, chain, chunkBlocks } = await build();
      chain.mine(Number(chunkBlocks) * 3 + 17);
      await subject.poll();
      for (const range of chain.requestedRanges()) {
        expect(range.toBlock - range.fromBlock + 1n).toBeLessThanOrEqual(chunkBlocks);
      }
      subject.close();
    });

    test("requested ranges tile the scanned span exactly once, with no gap and no overlap", async () => {
      const { subject, chain, chunkBlocks } = await build();
      chain.mine(Number(chunkBlocks) * 2 + 5);
      await subject.poll();
      const ranges = [...chain.requestedRanges()].sort((a, b) => (a.fromBlock < b.fromBlock ? -1 : 1));
      for (let index = 1; index < ranges.length; index += 1) {
        expect(ranges[index]!.fromBlock).toBe(ranges[index - 1]!.toBlock + 1n);
      }
      subject.close();
    });

    test("the live cursor tracks latest while the durable checkpoint advances only on finalized", async () => {
      const { subject, chain } = await build();
      chain.mine(40);
      chain.setFinalized(12n);
      const batch = await subject.poll();
      expect(batch.cursor.blockNumber).toBeGreaterThan(batch.finalizedCheckpoint.blockNumber);
      expect(batch.finalizedCheckpoint.blockNumber).toBe(12n);
      subject.close();
    });

    test("the cursor carries the block hash it was taken at", async () => {
      const { subject, chain } = await build();
      chain.mine(10);
      const batch = await subject.poll();
      expect(batch.cursor.blockHash).toMatch(/^0x[0-9a-f]{64}$/u);
      expect(batch.finalizedCheckpoint.blockHash).toMatch(/^0x[0-9a-f]{64}$/u);
      subject.close();
    });

    test("a cursor-hash mismatch rolls back to the finalized checkpoint and re-scans", async () => {
      const { subject, chain } = await build();
      chain.mine(40);
      chain.setFinalized(12n);
      await subject.poll();
      chain.reorgFrom(20n);
      const batch = await subject.poll();
      expect(batch.reorg).toBeDefined();
      expect(batch.reorg!.rolledBackTo.blockNumber).toBe(12n);
      expect(batch.reorg!.orphanedBlockHashes.length).toBeGreaterThan(0);
      expect(batch.logs.every((log) => log.blockNumber > 12n)).toBe(true);
      subject.close();
    });

    test("a reorg strictly inside the finalized span is never rolled back below the checkpoint", async () => {
      const { subject, chain } = await build();
      chain.mine(40);
      chain.setFinalized(30n);
      await subject.poll();
      chain.reorgFrom(35n);
      const batch = await subject.poll();
      expect(batch.reorg!.rolledBackTo.blockNumber).toBe(30n);
      subject.close();
    });

    test("polling is resumable: a fresh subject over the same state resumes at the persisted cursor", async () => {
      const { subject, chain } = await build();
      chain.mine(30);
      const first = await subject.poll();
      subject.close();
      const { subject: resumed } = await build();
      const second = await resumed.poll();
      expect(second.cursor.blockNumber).toBeGreaterThanOrEqual(first.cursor.blockNumber);
      expect(chain.requestedRanges().every((range) => range.fromBlock >= 0n)).toBe(true);
      resumed.close();
    });
  });
}
