import {
  BENCHMARKING_PROTOCOL,
  expectedCellCount,
  parseBenchmark,
  parseRun,
  sealBenchmark,
  sealRun,
  type BenchmarkRecord,
  type RunRecord,
} from "@jinn-network/benchmarking-records";
import { describe, expect, test } from "vitest";
import {
  MarketplaceCompositionValidationError,
  validateMarketplaceBudget,
} from "./budget-validation.js";
import { validateMarketplaceComposition } from "./venue.js";

const TASK_DIGEST = "8c0771ce49731c14e47d2103710e440abad04d138fc0163be2e9ffa7d9dd838f";

function bench(items = 1): { bench: BenchmarkRecord; benchDigest: string } {
  const itemsList = Array.from({ length: items }, () => ({
    task: { digest: { sha256: TASK_DIGEST } },
  }));
  const sealed = sealBenchmark({
    protocol: BENCHMARKING_PROTOCOL,
    name: "budget probe",
    description: "budget validation fixture",
    author: "urn:uuid:10000000-0000-5000-8000-000000000001",
    version: "1.0.0",
    items: itemsList,
    reveal: { policy: "immediate" },
  });
  return {
    bench: parseBenchmark(sealed.bytes),
    benchDigest: sealed.digest.slice("sha256:".length),
  };
}

function openRun(
  benchDigest: string,
  replicates = 1,
  arms = 1,
  budget?: RunRecord["budget"],
): RunRecord {
  const armIds = ["armA", "armB", "armC", "armD"];
  const armList = Array.from({ length: arms }, (_, index) => ({
    armId: armIds[index]!,
    pinning: {
      harness: { id: "kit", version: "1" },
      model: { id: `model-${armIds[index]}` },
    },
  }));
  return parseRun(sealRun({
    protocol: BENCHMARKING_PROTOCOL,
    benchmark: { digest: { sha256: benchDigest } },
    owner: "urn:uuid:20000000-0000-5000-8000-000000000002",
    arms: armList,
    replicates,
    policy: {
      completenessFloor: "1",
      cellWindow: 3_600_000,
      replacement: { allowed: false },
      independence: "gating",
      evaluation: { minVerdicts: 1, distinctEvaluator: true },
      submissionBaseline: { isolationPolicy: "fixture" },
    },
    venue: { kind: "open-competition" },
    budget: budget ?? {
      perCell: { solve: "10", evaluate: "5" },
      hardCap: "100",
      unit: "wei",
    },
    closeAt: "2099-01-01T00:00:00Z",
  }).bytes);
}

describe("validateMarketplaceBudget exact decimal coherence", () => {
  test("accepts hardCap exactly equal to expectedCellCount × (solve + evaluate)", () => {
    const { bench: b, benchDigest } = bench(2);
    const r = openRun(benchDigest, 2, 2, {
      perCell: { solve: "1.5", evaluate: "2.5" },
      hardCap: "64",
      unit: "wei",
    });
    expect(() => validateMarketplaceBudget(b, r)).not.toThrow();
  });

  test("rejects hardCap one unit under minimum at common scale", () => {
    const { bench: b, benchDigest } = bench(1);
    const r = openRun(benchDigest, 1, 1, {
      perCell: { solve: "10", evaluate: "5" },
      hardCap: "14.99",
      unit: "wei",
    });
    expect(() => validateMarketplaceBudget(b, r)).toThrow(MarketplaceCompositionValidationError);
  });

  test("rejects mixed-scale hardCap below minimum when solve/evaluate use fractional spelling", () => {
    const { bench: b, benchDigest } = bench(1);
    const r = openRun(benchDigest, 1, 1, {
      perCell: { solve: "0.10", evaluate: "0.05" },
      hardCap: "0.149",
      unit: "USD",
    });
    expect(() => validateMarketplaceBudget(b, r)).toThrow(MarketplaceCompositionValidationError);
  });

  test("accepts huge values above 2^53 without Number conversion", () => {
    const { bench: b, benchDigest } = bench(1);
    const huge = "9007199254740993";
    const r = openRun(benchDigest, 1, 1, {
      perCell: { solve: huge, evaluate: "1" },
      hardCap: "9007199254740994",
      unit: "wei",
    });
    expect(() => validateMarketplaceBudget(b, r)).not.toThrow();
  });

  test("wraps expectedCellCount overflow as composition validation error", () => {
    const { bench: b, benchDigest } = bench(1);
    const r = openRun(benchDigest, 1, 1);
    r.replicates = 9_007_199_254_740_992;
    expect(() => expectedCellCount(b, r)).toThrow(RangeError);
    expect(() => validateMarketplaceBudget(b, r)).toThrow(MarketplaceCompositionValidationError);
  });

  test("rejects zero hardCap", () => {
    const { bench: b, benchDigest } = bench(1);
    const r = openRun(benchDigest, 1, 1, {
      perCell: { solve: "1", evaluate: "1" },
      hardCap: "0",
      unit: "wei",
    });
    expect(() => validateMarketplaceBudget(b, r)).toThrow(MarketplaceCompositionValidationError);
  });
});

describe("validateMarketplaceComposition validation-before-effect vectors", () => {
  test("requires bench + run and rejects self-run before budget checks", () => {
    const { bench: b, benchDigest } = bench(1);
    const r = openRun(benchDigest, 1, 1);
    r.venue = { kind: "self-run" };
    expect(() => validateMarketplaceComposition(b, r)).toThrow(MarketplaceCompositionValidationError);
  });
});
