import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  BENCHMARKING_PROTOCOL,
  documentDigest,
  parseBenchmark,
  parseRun,
  type BenchmarkRecord,
  type RunRecord,
} from "@jinn-network/benchmarking-records";
import type { BackendCapabilities } from "@jinn-network/task-execution-backend";
import { describe, expect, test } from "vitest";
import { planRun, type BenchmarkPlanInput } from "./plan.js";
import { quoteRun } from "./quote.js";

async function loadMiniature(name: string): Promise<Uint8Array> {
  return new Uint8Array(
    await readFile(
      fileURLToPath(
        new URL(`../../testing/fixtures/miniature-run/${name}`, import.meta.url),
      ),
    ),
  );
}

function basePlan(benchmarkDigestHex: string): BenchmarkPlanInput {
  return {
    benchmarkDigest: benchmarkDigestHex,
    owner: "urn:uuid:20000000-0000-5000-8000-000000000002",
    arms: [
      { armId: "armA", pinning: { model: { id: "model-a" }, harness: { id: "kit", version: "1" } } },
      { armId: "armB", pinning: { model: { id: "model-b" }, harness: { id: "kit", version: "1" } } },
    ],
    replicates: 2,
    policy: {
      completenessFloor: "0.5",
      cellWindow: 3_600_000,
      replacement: { allowed: true, maxPerCell: 1 },
      independence: "gating",
      evaluation: { minVerdicts: 1, distinctEvaluator: true },
      submissionBaseline: { isolationPolicy: "fixture" },
    },
    analysisPlan: [
      { method: "jinn.benchmarking.method/wilson", version: "1", parameters: { verdictRule: "unanimous" } },
    ],
    venue: { kind: "self-run", note: "fixture-only append-order venue" },
    closeAt: "2026-08-04T00:00:00Z",
  };
}

describe("planRun (§10.1 op 2)", () => {
  test("produces a sealed Run whose digest is stable and whose closeAt is required", () => {
    const input = basePlan("11933faab6845e14ce2584871814b9cc3bb5bf8122ec09c24ce4d7a455808bff");
    const first = planRun(input);
    const second = planRun(input);
    expect(first.digest).toBe(second.digest);
    expect(first.bytes).toEqual(second.bytes);
    expect(first.record.protocol).toBe(BENCHMARKING_PROTOCOL);
    expect(first.record.closeAt).toBe("2026-08-04T00:00:00Z");
    expect(documentDigest(first.bytes)).toBe(first.digest);
    expect(parseRun(first.bytes)).toEqual(first.record);
  });

  test("rejects a plan missing closeAt", () => {
    const input = basePlan("11933faab6845e14ce2584871814b9cc3bb5bf8122ec09c24ce4d7a455808bff");
    delete (input as { closeAt?: string }).closeAt;
    expect(() => planRun(input)).toThrow(/closeAt/);
  });
});

function capabilitiesStub(overrides: Partial<BackendCapabilities> = {}): BackendCapabilities {
  return {
    taskProfiles: ["https://jinn.network/task-profiles/repository-work/1.0"],
    inputMediaTypes: ["text/plain"],
    outputMediaTypes: ["text/plain"],
    cancel: true,
    watch: true,
    preflight: false,
    fetchArtifact: false,
    confidentialInputs: false,
    signedObservations: false,
    signedDeliveries: false,
    evidenceCapture: "none",
    deadlineEnforcement: true,
    isolation: ["fixture"],
    attempts: { maxTotal: [1, 1], maxConcurrent: [1, 1] },
    runPinning: {
      keys: [
        { key: "harness", inventory: ["kit"], posture: "enforced" },
        { key: "model", inventory: ["model-a", "model-b"], posture: "enforced" },
        { key: "isolationPolicy", inventory: ["fixture"], posture: "enforced" },
      ],
    },
    ...overrides,
  };
}

describe("quoteRun (§10.1 op 3)", () => {
  test("computes expected cell count over the miniature-run benchmark", async () => {
    const bench = parseBenchmark(await loadMiniature("benchmark.json"));
    const run = parseRun(await loadMiniature("run.json"));
    const quote = quoteRun(bench, run, capabilitiesStub());
    expect(quote.ok).toBe(true);
    if (!quote.ok) return;
    expect(quote.expectedCellCount).toBe(12);
    expect(quote.errors).toEqual([]);
  });

  test("flags a hard-cap breach", async () => {
    const bench = parseBenchmark(await loadMiniature("benchmark.json"));
    const run = parseRun(await loadMiniature("run.json")) as RunRecord;
    const capped: RunRecord = {
      ...run,
      budget: {
        perCell: { solve: "1", evaluate: "1" },
        hardCap: "10",
        unit: "USD",
      },
    };
    const quote = quoteRun(bench, capped, capabilitiesStub());
    expect(quote.ok).toBe(false);
    expect(quote.errors.some((error) => error.code === "hard-cap-breach")).toBe(true);
  });

  test("flags an unsupported pinning key against a capabilities stub", async () => {
    const bench = parseBenchmark(await loadMiniature("benchmark.json"));
    const run = parseRun(await loadMiniature("run.json"));
    const quote = quoteRun(
      bench,
      run,
      capabilitiesStub({
        runPinning: {
          keys: [
            { key: "harness", inventory: ["kit"], posture: "enforced" },
            { key: "isolationPolicy", inventory: ["fixture"], posture: "enforced" },
          ],
        },
      }),
    );
    expect(quote.ok).toBe(false);
    expect(quote.errors.some((error) => error.code === "unsupported-requirement")).toBe(true);
  });
});
