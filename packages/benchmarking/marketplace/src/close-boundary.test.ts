import { BENCHMARKING_PROTOCOL, parseRun, sealBenchmark, sealRun, type RunRecord } from "@jinn-network/benchmarking-records";
import { describe, expect, test } from "vitest";
import {
  CloseBoundaryResolutionError,
  marketplaceCloseBoundary,
} from "./close-boundary.js";

const BENCH_DIGEST = "b".repeat(64);

function minimalRun(closeAt: string): RunRecord {
  const sealedBench = sealBenchmark({
    protocol: BENCHMARKING_PROTOCOL,
    name: "close-boundary probe",
    description: "marketplace close boundary fixture",
    author: "urn:uuid:10000000-0000-5000-8000-000000000001",
    version: "1.0.0",
    items: [{ task: { digest: { sha256: BENCH_DIGEST } } }],
    reveal: { policy: "immediate" },
  });
  return parseRun(sealRun({
    protocol: BENCHMARKING_PROTOCOL,
    benchmark: { digest: { sha256: sealedBench.digest.slice("sha256:".length) } },
    owner: "urn:uuid:20000000-0000-5000-8000-000000000002",
    arms: [{
      armId: "armA",
      pinning: { model: { id: "model-a" }, harness: { id: "kit", version: "1" } },
    }],
    replicates: 1,
    policy: {
      completenessFloor: "1",
      cellWindow: 3_600_000,
      replacement: { allowed: false },
      independence: "gating",
      evaluation: { minVerdicts: 1, distinctEvaluator: true },
      submissionBaseline: { isolationPolicy: "fixture" },
    },
    venue: { kind: "open-competition" },
    budget: {
      perCell: { solve: "1", evaluate: "1" },
      hardCap: "10",
      unit: "wei",
    },
    closeAt,
  }).bytes);
}

describe("marketplaceCloseBoundary", () => {
  test("returns exact sealed closeAt and the first finalized anchor at or after it", async () => {
    const run = minimalRun("2026-08-04T00:00:00Z");
    const resolver = marketplaceCloseBoundary({
      blocks: {
        async firstFinalizedAtOrAfter(closeAt) {
          expect(closeAt).toBe("2026-08-04T00:00:00Z");
          return {
            chain: "eip155:84532",
            blockNumber: 42,
            blockHash: "0xabc",
            timestamp: "2026-08-04T00:00:05Z",
          };
        },
      },
    });
    const boundary = await resolver.resolve(run);
    expect(boundary.at).toBe("2026-08-04T00:00:00Z");
    expect(boundary.anchor).toEqual({
      chain: "eip155:84532",
      blockNumber: 42,
      blockHash: "0xabc",
    });
  });

  test("never substitutes block timestamp into at", async () => {
    const run = minimalRun("2026-08-03T12:00:00Z");
    const resolver = marketplaceCloseBoundary({
      blocks: {
        async firstFinalizedAtOrAfter() {
          return {
            chain: "eip155:84532",
            blockNumber: 99,
            blockHash: "0xdef",
            timestamp: "2026-08-05T00:00:00Z",
          };
        },
      },
    });
    const boundary = await resolver.resolve(run);
    expect(boundary.at).toBe("2026-08-03T12:00:00Z");
    expect(boundary.at).not.toBe("2026-08-05T00:00:00Z");
  });

  test("fails closed when no finalized anchor exists", async () => {
    const run = minimalRun("2026-08-04T00:00:00Z");
    const resolver = marketplaceCloseBoundary({
      blocks: {
        async firstFinalizedAtOrAfter() {
          return undefined;
        },
      },
    });
    await expect(resolver.resolve(run)).rejects.toBeInstanceOf(CloseBoundaryResolutionError);
  });
});
