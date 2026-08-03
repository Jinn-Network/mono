// SPDX-License-Identifier: MIT

import { expressAsRunPinning } from "@jinn-network/policy-identity";
import { describe, expect, test } from "vitest";
import { assertArmsAgreeOnFrozenAxes, buildWaveArms, checkCandidateAgainstCampaign } from "./arms.js";
import { PolicyOptimizationError } from "./errors.js";
import {
  CANDIDATE,
  PARENT,
  campaignFor,
  candidateFor,
  tupleFor,
} from "./testing/wave-fixtures.js";
import type { AdmittedCandidate } from "./wave-types.js";

const CAMPAIGN = campaignFor({
  developmentBenchmark: `sha256:${"d".repeat(64)}`,
  promotionBenchmark: `sha256:${"e".repeat(64)}`,
  seeds: [PARENT],
  allocation: { policyRef: "uniform/1.0", parameters: {} },
});

function category(build: () => unknown): string {
  try {
    build();
  } catch (error) {
    if (error instanceof PolicyOptimizationError) return error.category;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("arms are policy tuples expressed as run pinning (§6.1)", () => {
  test("an arm's pinning is the whole tuple expression, not only the mutable axis", () => {
    const [arm] = buildWaveArms(CAMPAIGN, [PARENT]);
    expect(arm!.pinning).toEqual(expressAsRunPinning(PARENT.tuple));
    // The frozen axes travel on the arm, which is what makes the byte-identity check meaningful.
    expect(Object.keys(arm!.pinning).sort()).toEqual([
      "harness", "isolationPolicy", "loadout", "model",
    ]);
  });

  test("arms are ordered by armId, so two hosts seal the same wave to the same bytes", () => {
    const forward = buildWaveArms(CAMPAIGN, [PARENT, CANDIDATE]);
    const reversed = buildWaveArms(CAMPAIGN, [CANDIDATE, PARENT]);
    expect(forward.map((arm) => arm.armId)).toEqual(["candidate", "parent"]);
    expect(reversed).toEqual(forward);
  });

  test("every arm byte-shares every frozen axis", () => {
    const arms = buildWaveArms(CAMPAIGN, [PARENT, CANDIDATE]);
    expect(() => assertArmsAgreeOnFrozenAxes(CAMPAIGN, arms)).not.toThrow();
    for (const axis of ["harness", "model", "isolationPolicy"] as const) {
      const values = arms.map((arm) => JSON.stringify((arm.pinning as Record<string, unknown>)[axis]));
      expect(new Set(values).size).toBe(1);
    }
  });

  test("a candidate that drifted off a frozen axis is refused, not silently run", () => {
    const drifted: AdmittedCandidate = {
      ...CANDIDATE,
      tuple: { ...tupleFor("drifted", "3"), model: { id: "anthropic/claude-sonnet-4-5" } },
    };
    expect(category(() => buildWaveArms(CAMPAIGN, [PARENT, drifted])))
      .toBe("frozen-axis-disagreement");
  });

  test("a constraint-shaped mutable axis is refused", () => {
    const vague: AdmittedCandidate = {
      ...CANDIDATE,
      tuple: { ...tupleFor("vague", "4"), loadout: null },
    };
    expect(category(() => buildWaveArms(CAMPAIGN, [vague]))).toBe("constraint-shaped-pin");
  });

  test("the same tuple twice is one arm, and asking for two is a refusal (§7.3)", () => {
    const twin: AdmittedCandidate = { ...PARENT, armId: "parent-again" };
    expect(category(() => buildWaveArms(CAMPAIGN, [PARENT, twin]))).toBe("wave-composition");
  });

  test("a duplicate armId is refused before sealRun sees it", () => {
    const clash: AdmittedCandidate = { ...CANDIDATE, armId: PARENT.armId };
    expect(category(() => buildWaveArms(CAMPAIGN, [PARENT, clash]))).toBe("wave-composition");
  });

  test("an armId outside the records grammar is refused", () => {
    expect(category(() => buildWaveArms(CAMPAIGN, [candidateFor("arm/one", "x", "5")])))
      .toBe("wave-composition");
  });

  test("a wave with no arms compares nothing", () => {
    expect(category(() => buildWaveArms(CAMPAIGN, []))).toBe("wave-composition");
  });

  test("checkCandidateAgainstCampaign reports every disagreement, not only the first", () => {
    const doubled: AdmittedCandidate = {
      ...CANDIDATE,
      tuple: {
        ...tupleFor("doubled", "6"),
        model: { id: "anthropic/claude-sonnet-4-5" },
        isolationPolicy: "sandboxed",
      },
    };
    const issues = checkCandidateAgainstCampaign(CAMPAIGN, doubled, "candidates.0.tuple");
    expect(issues.map((entry) => entry.path).sort()).toEqual([
      "candidates.0.tuple.isolationPolicy",
      "candidates.0.tuple.model",
    ]);
  });
});
