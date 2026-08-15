// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import {
  compareExactDecimals,
  compareObservedRates,
  decideAllocation,
  type AllocationInput,
} from "./allocation.js";
import { PolicyOptimizationError } from "./errors.js";
import {
  CANDIDATE,
  OBJECTIVE_METHOD,
  PARENT,
  campaignFor,
  candidateFor,
} from "./testing/wave-fixtures.js";
import type { CampaignAllocation } from "./types.js";
import type { AdmittedCandidate, WaveReportRow } from "./wave-types.js";

const THIRD = candidateFor("third", "repo-work-third", "3");
const TASK_A = "a".repeat(64);
const TASK_B = "b".repeat(64);
const TASK_C = "c".repeat(64);

function campaign(allocation: CampaignAllocation) {
  return campaignFor({
    developmentBenchmark: `sha256:${"d".repeat(64)}`,
    promotionBenchmark: `sha256:${"e".repeat(64)}`,
    seeds: [PARENT],
    allocation,
  });
}

function input(
  allocation: CampaignAllocation,
  overrides: Partial<AllocationInput> = {},
): AllocationInput {
  return {
    campaign: campaign(allocation),
    waveNumber: 2,
    population: [PARENT, CANDIDATE, THIRD] as readonly AdmittedCandidate[],
    taskDigests: [TASK_A, TASK_B, TASK_C],
    ...overrides,
  };
}

function reportRow(
  candidate: AdmittedCandidate,
  value: string,
  reportDigest: string,
): WaveReportRow {
  return {
    reportDigest,
    waveNumber: 1,
    tupleDigest: candidate.tupleDigest,
    method: { id: OBJECTIVE_METHOD.id, version: OBJECTIVE_METHOD.version },
    value,
  };
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

describe("exact comparisons (no statistic is computed — ruling R3)", () => {
  test("decimals of different scale compare exactly", () => {
    expect(compareExactDecimals("0.5", "0.50")).toBe(0);
    expect(compareExactDecimals("0.4999", "0.5")).toBe(-1);
    expect(compareExactDecimals("1", "0.9999999999999999999")).toBe(1);
  });

  test("a value that is not a plain decimal is unorderable, never 'equal'", () => {
    expect(compareExactDecimals("0.5", "NaN")).toBeUndefined();
    expect(compareExactDecimals("-0.5", "0.5")).toBeUndefined();
  });

  test("observed rates compare by exact cross-multiplication, and refuse to guess at den 0", () => {
    expect(compareObservedRates({ num: 1, den: 3 }, { num: 2, den: 6 })).toBe(0);
    expect(compareObservedRates({ num: 1, den: 3 }, { num: 1, den: 2 })).toBe(-1);
    expect(compareObservedRates({ num: 0, den: 0 }, { num: 1, den: 2 })).toBeUndefined();
  });
});

describe("uniform/1.0", () => {
  test("retains every candidate and every task", () => {
    const decision = decideAllocation(input({ policyRef: "uniform/1.0", parameters: { replicates: 2 } }));
    expect(decision.retained).toHaveLength(3);
    expect(decision.pruned).toEqual([]);
    expect(decision.taskDigests).toEqual([TASK_A, TASK_B, TASK_C]);
    expect(decision.replicates).toBe(2);
  });

  test("replicates defaults to 1 and refuses a non-positive value", () => {
    expect(decideAllocation(input({ policyRef: "uniform/1.0", parameters: {} })).replicates).toBe(1);
    expect(category(() => decideAllocation(
      input({ policyRef: "uniform/1.0", parameters: { replicates: 0 } }),
    ))).toBe("allocation-policy");
  });
});

describe("drop-bottom-k/1.0", () => {
  const policy: CampaignAllocation = { policyRef: "drop-bottom-k/1.0", parameters: { k: 1 } };

  test("prunes the lowest-valued arm and journals which Report said so", () => {
    const decision = decideAllocation(input(policy, {
      reports: [
        reportRow(PARENT, "0.7000", `sha256:${"1".repeat(64)}`),
        reportRow(CANDIDATE, "0.9000", `sha256:${"1".repeat(64)}`),
        reportRow(THIRD, "0.2000", `sha256:${"1".repeat(64)}`),
      ],
    }));
    expect(decision.pruned.map((entry) => entry.tupleDigest)).toEqual([THIRD.tupleDigest]);
    expect(decision.pruned[0]!.reason).toContain(OBJECTIVE_METHOD.id);
    // No tie: the experiment decided it, and the reason says nothing about the organic bucket.
    expect(decision.pruned[0]!.reason).not.toContain("tie broken");
    expect(decision.inputs.reports).toEqual([`sha256:${"1".repeat(64)}`]);
    expect(decision.retained).not.toContain(THIRD.tupleDigest);
  });

  test("a candidate nothing has measured is retained, not pruned for arriving late", () => {
    const decision = decideAllocation(input(policy, {
      reports: [
        reportRow(PARENT, "0.7000", `sha256:${"1".repeat(64)}`),
        reportRow(CANDIDATE, "0.9000", `sha256:${"1".repeat(64)}`),
      ],
    }));
    expect(decision.retained).toContain(THIRD.tupleDigest);
    expect(decision.pruned.map((entry) => entry.tupleDigest)).toEqual([PARENT.tupleDigest]);
    expect(decision.notes.join(" ")).toContain("retained unranked");
  });

  test("wave 1 has no Reports and prunes nothing", () => {
    const decision = decideAllocation(input(policy, { waveNumber: 1, reports: [] }));
    expect(decision.pruned).toEqual([]);
    expect(decision.retained).toHaveLength(3);
  });

  test("minCandidates floors the pruning and says it did", () => {
    const decision = decideAllocation(input(
      { policyRef: "drop-bottom-k/1.0", parameters: { k: 3, minCandidates: 2 } },
      {
        reports: [
          reportRow(PARENT, "0.7000", `sha256:${"1".repeat(64)}`),
          reportRow(CANDIDATE, "0.9000", `sha256:${"1".repeat(64)}`),
          reportRow(THIRD, "0.2000", `sha256:${"1".repeat(64)}`),
        ],
      },
    ));
    expect(decision.retained).toHaveLength(2);
    expect(decision.notes.join(" ")).toContain("minCandidates=2");
  });

  test("ties break on the organic bucket — §6.2's named hazard, exercised", () => {
    const reports = [
      reportRow(PARENT, "0.5000", `sha256:${"1".repeat(64)}`),
      reportRow(CANDIDATE, "0.5000", `sha256:${"1".repeat(64)}`),
      reportRow(THIRD, "0.9000", `sha256:${"1".repeat(64)}`),
    ];
    const organic = (candidate: AdmittedCandidate, num: number, den: number) => ({
      inputRefs: [`sha256:${candidate.tupleDigest.slice(-64)}`],
      tupleDigest: candidate.tupleDigest,
      bucket: "organic" as const,
      passRate: { num, den },
    });
    const favouringCandidate = decideAllocation(input(policy, {
      reports,
      outcomes: [organic(PARENT, 9, 10), organic(CANDIDATE, 1, 10)],
    }));
    // Experimentally tied; the organic bucket decides which of the two goes.
    expect(favouringCandidate.pruned.map((entry) => entry.tupleDigest)).toEqual([CANDIDATE.tupleDigest]);
    // M3: a reader of the journal can see the experiment did NOT decide this one.
    expect(favouringCandidate.pruned[0]!.reason)
      .toContain("; tie broken on the organic bucket (1/10 vs 9/10)");

    const favouringParent = decideAllocation(input(policy, {
      reports,
      outcomes: [organic(PARENT, 1, 10), organic(CANDIDATE, 9, 10)],
    }));
    expect(favouringParent.pruned.map((entry) => entry.tupleDigest)).toEqual([PARENT.tupleDigest]);
    expect(favouringParent.pruned[0]!.reason)
      .toContain("; tie broken on the organic bucket (1/10 vs 9/10)");
    // Both runs consumed rows, and both journal exactly which ones.
    expect(favouringParent.inputs.outcomes).toHaveLength(2);
  });

  test("a Report value the product cannot order is refused, never ranked on regardless", () => {
    expect(category(() => decideAllocation(input(policy, {
      reports: [
        reportRow(PARENT, "0.7000", `sha256:${"1".repeat(64)}`),
        reportRow(CANDIDATE, "high", `sha256:${"1".repeat(64)}`),
        reportRow(THIRD, "0.2000", `sha256:${"1".repeat(64)}`),
      ],
    })))).toBe("allocation-policy");
  });

  test("rows for a method the campaign does not declare are ignored", () => {
    const decision = decideAllocation(input(policy, {
      reports: [{
        ...reportRow(THIRD, "0.0100", `sha256:${"1".repeat(64)}`),
        method: { id: "jinn.benchmarking.method/other", version: "1" },
      }],
    }));
    expect(decision.pruned).toEqual([]);
  });
});

describe("informativeness/1.0", () => {
  const policy: CampaignAllocation = {
    policyRef: "informativeness/1.0",
    parameters: {
      minVerdicts: 4,
      lower: { num: 2, den: 100 },
      upper: { num: 70, den: 100 },
    },
  };

  const row = (taskDigest: string, num: number, den: number) => ({
    inputRefs: [`sha256:${taskDigest}`],
    taskDigest,
    bucket: "benchmark" as const,
    passRate: { num, den },
  });

  test("drops tasks everyone passes and tasks nobody passes", () => {
    const decision = decideAllocation(input(policy, {
      informativeness: [row(TASK_A, 10, 10), row(TASK_B, 0, 10), row(TASK_C, 5, 10)],
    }));
    expect(decision.taskDigests).toEqual([TASK_C]);
    expect(decision.droppedTasks.map((entry) => entry.taskDigest).sort()).toEqual([TASK_A, TASK_B]);
    expect(decision.inputs.informativeness).toHaveLength(3);
  });

  test("a task with too few verdicts is kept — thin evidence is not saturation", () => {
    const decision = decideAllocation(input(policy, {
      informativeness: [row(TASK_A, 3, 3), row(TASK_B, 5, 10), row(TASK_C, 5, 10)],
    }));
    expect(decision.taskDigests).toEqual([TASK_A, TASK_B, TASK_C]);
  });

  test("only the benchmark bucket is read for informativeness", () => {
    const decision = decideAllocation(input(policy, {
      informativeness: [{ ...row(TASK_A, 10, 10), bucket: "organic" }],
    }));
    expect(decision.taskDigests).toEqual([TASK_A, TASK_B, TASK_C]);
  });

  test("when everything looks saturated the whole slate is kept, and the note says so", () => {
    const decision = decideAllocation(input(policy, {
      informativeness: [row(TASK_A, 10, 10), row(TASK_B, 10, 10), row(TASK_C, 10, 10)],
    }));
    expect(decision.taskDigests).toEqual([TASK_A, TASK_B, TASK_C]);
    expect(decision.droppedTasks).toEqual([]);
    expect(decision.notes.join(" ")).toContain("saturated");
  });

  test("there is no default threshold; omitting one is refused", () => {
    expect(category(() => decideAllocation(input(
      { policyRef: "informativeness/1.0", parameters: { minVerdicts: 4 } },
      { informativeness: [row(TASK_A, 10, 10)] },
    )))).toBe("allocation-policy");
  });
});

describe("refusals that keep a campaign from believing it allocated", () => {
  test("an unknown policy reference never falls back to uniform", () => {
    expect(category(() => decideAllocation(input({ policyRef: "bandit/9.9", parameters: {} }))))
      .toBe("allocation-policy");
  });

  test("a Report row naming a tuple outside the population is refused", () => {
    expect(category(() => decideAllocation(input(
      { policyRef: "drop-bottom-k/1.0", parameters: { k: 1 } },
      { reports: [reportRow(candidateFor("ghost", "ghost", "9"), "0.1", `sha256:${"1".repeat(64)}`)] },
    )))).toBe("allocation-policy");
  });

  test("an empty population decides nothing", () => {
    expect(category(() => decideAllocation(input(
      { policyRef: "uniform/1.0", parameters: {} },
      { population: [] },
    )))).toBe("allocation-policy");
  });

  test("the decision is deterministic: same rows in, same bytes out", () => {
    const built = () => decideAllocation(input(
      { policyRef: "drop-bottom-k/1.0", parameters: { k: 1 } },
      {
        reports: [
          reportRow(PARENT, "0.7000", `sha256:${"1".repeat(64)}`),
          reportRow(CANDIDATE, "0.9000", `sha256:${"2".repeat(64)}`),
          reportRow(THIRD, "0.2000", `sha256:${"3".repeat(64)}`),
        ],
      },
    ));
    expect(JSON.stringify(built())).toEqual(JSON.stringify(built()));
  });
});
