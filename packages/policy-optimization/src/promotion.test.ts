// SPDX-License-Identifier: MIT

import { itemTaskDigest } from "@jinn-network/benchmarking-records";
import { describe, expect, test } from "vitest";
import { PolicyOptimizationError } from "./errors.js";
import { checkPromotionReveal, objectiveAnalysisPlan, planPromotionRun } from "./promotion.js";
import {
  CANDIDATE,
  OBJECTIVE_METHOD,
  PARENT,
  benchmarkFor,
  campaignFor,
  runSettings,
  tasksFor,
} from "./testing/wave-fixtures.js";
import { NO_CELLS_COMMITTED } from "./wave-types.js";

const DEV = benchmarkFor({
  name: "dev slate",
  tasks: tasksFor(["alpha", "beta"]),
  reveal: { policy: "immediate" },
});
const HELD_OUT = tasksFor(["held-out one", "held-out two"]);
const PROMOTION = benchmarkFor({
  name: "promotion gate",
  tasks: HELD_OUT,
  reveal: { policy: "after-run" },
});
const CAMPAIGN_DIGEST = `sha256:${"c".repeat(64)}`;

const CAMPAIGN = campaignFor({
  developmentBenchmark: DEV.digest,
  promotionBenchmark: PROMOTION.digest,
  seeds: [PARENT],
  allocation: { policyRef: "uniform/1.0", parameters: {} },
});

function fullReveal(): ReadonlyMap<string, Uint8Array> {
  return new Map(HELD_OUT.map((task) => [task.digest, task.bytes]));
}

function category(build: () => unknown): string {
  try {
    build();
  } catch (error) {
    if (error instanceof PolicyOptimizationError) return error.category;
    throw error;
  }
  throw new Error("expected a refusal");
}

function promote(overrides: Partial<Parameters<typeof planPromotionRun>[0]> = {}) {
  return planPromotionRun({
    campaign: CAMPAIGN,
    campaignDigest: CAMPAIGN_DIGEST,
    phase: "EXPLORING",
    candidates: [PARENT, CANDIDATE],
    reveal: { benchmarkBytes: PROMOTION.bytes, revealed: fullReveal() },
    settings: runSettings(),
    committed: NO_CELLS_COMMITTED,
    waveNumber: 3,
    ...overrides,
  });
}

describe("the promotion Run is sealed out of EXPLORING, against a revealed gate (§6.3)", () => {
  test("a fully revealed, digest-correct gate admits", () => {
    const admission = checkPromotionReveal(CAMPAIGN, "EXPLORING", {
      benchmarkBytes: PROMOTION.bytes,
      revealed: fullReveal(),
    });
    expect(admission).toEqual({
      promotionBenchmark: PROMOTION.digest,
      revealedItems: 2,
      committedItems: 2,
    });
  });

  test("every phase other than EXPLORING is refused", () => {
    for (const phase of ["DRAFT", "CONFIRMING", "CLOSED"] as const) {
      expect(category(() => checkPromotionReveal(CAMPAIGN, phase, {
        benchmarkBytes: PROMOTION.bytes,
        revealed: fullReveal(),
      }))).toBe("promotion-discipline");
    }
  });

  test("a partial reveal is refused: the Run runs the whole gate or none of it", () => {
    const partial = new Map([[HELD_OUT[0]!.digest, HELD_OUT[0]!.bytes]]);
    expect(category(() => checkPromotionReveal(CAMPAIGN, "EXPLORING", {
      benchmarkBytes: PROMOTION.bytes,
      revealed: partial,
    }))).toBe("promotion-discipline");
  });

  test("bytes that do not match a commitment are a reveal-consistency failure, not a partial reveal", () => {
    const tampered = new Map([
      [HELD_OUT[0]!.digest, HELD_OUT[1]!.bytes],
      [HELD_OUT[1]!.digest, HELD_OUT[1]!.bytes],
    ]);
    expect(category(() => checkPromotionReveal(CAMPAIGN, "EXPLORING", {
      benchmarkBytes: PROMOTION.bytes,
      revealed: tampered,
    }))).toBe("promotion-benchmark");
  });

  test("a Benchmark the campaign does not name cannot stand in as the gate", () => {
    expect(category(() => checkPromotionReveal(CAMPAIGN, "EXPLORING", {
      benchmarkBytes: DEV.bytes,
      revealed: new Map(),
    }))).toBe("promotion-benchmark");
  });
});

describe("the promotion Run preregisters the campaign's objective and samples flat", () => {
  test("the objective's methods land in the analysis plan, parameters verbatim", () => {
    const { plan } = promote();
    expect(plan.run.record.analysisPlan).toEqual([{
      method: OBJECTIVE_METHOD.id,
      version: OBJECTIVE_METHOD.version,
      parameters: OBJECTIVE_METHOD.parameters,
    }]);
    expect(plan.kind).toBe("promotion");
    expect(plan.allocation).toBeUndefined();
  });

  test("it runs the whole gate, every arm, at one Run-wide replicate count", () => {
    const { plan } = promote({ replicates: 2 });
    expect(plan.benchmark.record.items.map(itemTaskDigest))
      .toEqual(HELD_OUT.map((task) => task.digest));
    expect(plan.run.record.arms.map((arm) => arm.armId)).toEqual(["candidate", "parent"]);
    expect(plan.cells).toBe(2 * 2 * 2);
  });

  test("a promotion Run past the hard cap is refused", () => {
    expect(category(() => promote({
      committed: { development: 258, promotion: 0, total: 258 },
    }))).toBe("budget-exceeded");
  });

  test("planning it twice is byte-identical", () => {
    expect(promote().plan.run.bytes).toEqual(promote().plan.run.bytes);
  });
});

describe("F-C7b-3: verdictRule is load-bearing for the preregistration derivation", () => {
  test("an objective method with no verdictRule parameter is refused at plan time", () => {
    const vague = campaignFor({
      developmentBenchmark: DEV.digest,
      promotionBenchmark: PROMOTION.digest,
      seeds: [PARENT],
      allocation: { policyRef: "uniform/1.0", parameters: {} },
      objectiveParameters: {},
    });
    expect(category(() => objectiveAnalysisPlan(vague))).toBe("promotion-discipline");
    expect(category(() => promote({ campaign: vague }))).toBe("promotion-discipline");
  });

  test("the parameters are copied, never repaired into agreement", () => {
    const plan = objectiveAnalysisPlan(CAMPAIGN);
    expect(plan![0]!.parameters).toEqual(OBJECTIVE_METHOD.parameters);
  });
});
