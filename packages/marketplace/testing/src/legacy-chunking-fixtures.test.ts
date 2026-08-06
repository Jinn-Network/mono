// SPDX-License-Identifier: MIT

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_LOG_CHUNK_BLOCKS } from "@jinn-network/marketplace-venue-base";
import { describe, expect, test } from "vitest";
import {
  CHUNK_PLAN_FIXTURES,
  LEGACY_BOUNDED_SCAN_RULES,
  LEGACY_CHUNK_CONSTANTS,
  LEGACY_UNCHUNKED_LOOKBACK_FLOOR_BLOCKS,
  PUBLIC_BASE_GETLOGS_RANGE_CAP_BLOCKS,
  describeChunkPlanConformance,
  type ChunkRange,
} from "./legacy-chunking-fixtures.js";

/**
 * A count-convention planner. This is the reference the fixtures encode -- it exists so the
 * conformance driver is proven to assert, and so the fixture table's expected ranges are checked
 * against something executable rather than eyeballed.
 */
function planRanges(fromBlock: bigint, toBlock: bigint, chunkBlocks: bigint): ChunkRange[] {
  const ranges: ChunkRange[] = [];
  for (let start = fromBlock; start <= toBlock; start += chunkBlocks) {
    const end = start + chunkBlocks - 1n > toBlock ? toBlock : start + chunkBlocks - 1n;
    ranges.push({ fromBlock: start, toBlock: end });
  }
  return ranges;
}

describeChunkPlanConformance(async () => ({
  chunkBlocks: DEFAULT_LOG_CHUNK_BLOCKS,
  subject: {
    requestedRangesFor: async (fromBlock, toBlock) =>
      planRanges(fromBlock, toBlock, DEFAULT_LOG_CHUNK_BLOCKS),
  },
}));

describe("legacy chunking fixtures (design §6.6, program contract 12)", () => {
  test("every plan fixture's expected ranges match the count-convention reference", () => {
    for (const fixture of CHUNK_PLAN_FIXTURES) {
      expect(
        planRanges(fixture.fromBlock, fixture.toBlock, fixture.chunkBlocks),
        fixture.name,
      ).toEqual(fixture.expectedRanges);
    }
  });

  test("every plan fixture tiles its span exactly once with no gap and no overlap", () => {
    for (const fixture of CHUNK_PLAN_FIXTURES) {
      const ranges = fixture.expectedRanges;
      expect(ranges[0]!.fromBlock, fixture.name).toBe(fixture.fromBlock);
      expect(ranges[ranges.length - 1]!.toBlock, fixture.name).toBe(fixture.toBlock);
      for (let index = 1; index < ranges.length; index += 1) {
        expect(ranges[index]!.fromBlock, fixture.name).toBe(ranges[index - 1]!.toBlock + 1n);
      }
      for (const range of ranges) {
        expect(range.toBlock - range.fromBlock + 1n, fixture.name)
          .toBeLessThanOrEqual(fixture.chunkBlocks);
      }
    }
  });

  test("each recorded legacy constant's request width follows from its declared convention", () => {
    for (const entry of LEGACY_CHUNK_CONSTANTS) {
      const expected = entry.convention === "count" ? entry.value : entry.value + 1n;
      expect(entry.requestWidthBlocks, `${entry.name} @ ${entry.source}`).toBe(expected);
      expect(entry.withinPublicBaseCap, `${entry.name} @ ${entry.source}`).toBe(
        entry.requestWidthBlocks <= PUBLIC_BASE_GETLOGS_RANGE_CAP_BLOCKS,
      );
    }
  });

  test("the fresh chain log source's default fits inside the narrowest public Base cap", () => {
    // venue-base sizes in COUNT, so its default is its own request width -- no +1.
    expect(DEFAULT_LOG_CHUNK_BLOCKS).toBeLessThanOrEqual(PUBLIC_BASE_GETLOGS_RANGE_CAP_BLOCKS);
    // ...and it is no wider than the narrowest legacy scanner that provably survived #807/#801/#803.
    const logScanChunk = LEGACY_CHUNK_CONSTANTS.find(
      (entry) => entry.name === "LOG_SCAN_CHUNK",
    );
    expect(logScanChunk).toBeDefined();
    expect(DEFAULT_LOG_CHUNK_BLOCKS).toBeLessThanOrEqual(logScanChunk!.requestWidthBlocks);
  });

  test("the two bounded-scan exhaustion behaviors are both represented", () => {
    const behaviors = new Set(LEGACY_BOUNDED_SCAN_RULES.map((rule) => rule.onBudgetExhausted));
    expect([...behaviors].sort()).toEqual(["empty-result", "silent-prefix"]);
  });
});

// ── Drift guard against the live legacy oracles ──────────────────────────────
//
// The fixtures above are the surviving expression of behavior the one-swap deletes. While the
// legacy sources still exist, they are the oracle: a value edited there without editing the
// fixture is drift, and drift is exactly what §6.6 exists to prevent. Each check self-disables
// once its oracle is gone, so this suite retires with the code it guards rather than turning into
// a stale assertion about a deleted file.
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

function readOracle(relativePath: string): string | undefined {
  const absolute = `${repoRoot}${relativePath}`;
  return existsSync(absolute) ? readFileSync(absolute, "utf8") : undefined;
}

describe("legacy chunking oracles have not drifted from the fixtures", () => {
  for (const entry of LEGACY_CHUNK_CONSTANTS) {
    test(`${entry.name} in ${entry.source} still declares ${entry.value}`, () => {
      const source = readOracle(entry.source);
      if (source === undefined) {
        // The oracle has been deleted by the cutover; the fixture is now the sole record.
        expect(true).toBe(true);
        return;
      }
      const declaration = new RegExp(
        String.raw`\b${entry.name}\s*(?::\s*bigint\s*)?=\s*([0-9_]+)n`,
      ).exec(source);
      expect(declaration, `${entry.name} declaration not found in ${entry.source}`).not.toBeNull();
      expect(BigInt(declaration![1]!.replaceAll("_", ""))).toBe(entry.value);
    });
  }

  test("the unchunked TaskCreated recovery lookback still declares its 64-block floor", () => {
    const source = readOracle("client/src/adapters/mech/contracts.ts");
    if (source === undefined) {
      expect(true).toBe(true);
      return;
    }
    const declaration = /\bTASK_CREATED_RECOVERY_WINDOW_BLOCKS\s*=\s*([0-9_]+)n/.exec(source);
    expect(declaration).not.toBeNull();
    expect(BigInt(declaration![1]!.replaceAll("_", ""))).toBe(LEGACY_UNCHUNKED_LOOKBACK_FLOOR_BLOCKS);
  });

  test("the discovery floor's per-pass chunk caps still match the bounded-scan fixtures", () => {
    const source = readOracle("client/src/discovery/onchain.ts");
    if (source === undefined) {
      expect(true).toBe(true);
      return;
    }
    for (const constant of ["MAX_OPERATOR_COUNT_TASK_PAGES", "MAX_TASK_POST_COUNT_SCAN_PAGES"]) {
      const declaration = new RegExp(String.raw`\b${constant}\s*=\s*([0-9_]+)\b`).exec(source);
      expect(declaration, `${constant} declaration not found`).not.toBeNull();
      const value = Number(declaration![1]!.replaceAll("_", ""));
      expect(LEGACY_BOUNDED_SCAN_RULES.some((rule) => rule.maxChunksPerPass === value)).toBe(true);
    }
  });

  test("the discovery floor still sizes chunks as a delta, which is why the fixtures restate the rule in counts", () => {
    const source = readOracle("client/src/discovery/onchain.ts");
    if (source === undefined) {
      expect(true).toBe(true);
      return;
    }
    // Oldest-first mode: `end = start + chunkBlocks` inclusive, i.e. chunkBlocks + 1 blocks.
    expect(source).toContain("start + chunkBlocks > toBlock ? toBlock : start + chunkBlocks");
    expect(source).toContain("start += chunkBlocks + 1n");
  });
});
