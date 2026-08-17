import { describe, expect, it } from "vitest";
import type { SkillsBenchDemo1AdmittedCell } from "./skillsbench-demo1-declaration.js";
import {
  manipulationCheck,
  pairedDeltaEstimate,
  varianceDecomposition,
} from "./skillsbench-demo1-stats.js";

function cell(taskId: string, arm: SkillsBenchDemo1AdmittedCell["arm"], replicate: number, reward: number): SkillsBenchDemo1AdmittedCell {
  return {
    cellId: `${taskId}/${arm}/r${replicate}`,
    taskId,
    arm,
    replicate,
    reward: String(reward),
    rewardValue: reward,
    fullPass: reward === 1,
    baseImage: undefined,
  };
}

// alpha: A [1,0] vs B [1,0] — a tie with replicate noise. gamma: A [1,1] vs B [0,0] — a full split.
const CELLS: SkillsBenchDemo1AdmittedCell[] = [
  cell("alpha", "A-native-skill", 0, 1), cell("alpha", "A-native-skill", 1, 0),
  cell("alpha", "B-flat-claude-md", 0, 1), cell("alpha", "B-flat-claude-md", 1, 0),
  cell("alpha", "C-no-instructions", 0, 0),
  cell("gamma", "A-native-skill", 0, 1), cell("gamma", "A-native-skill", 1, 1),
  cell("gamma", "B-flat-claude-md", 0, 0), cell("gamma", "B-flat-claude-md", 1, 0),
  cell("gamma", "C-no-instructions", 0, 0),
];

describe("pairedDeltaEstimate", () => {
  it("computes the per-task and pooled paired estimate", () => {
    const estimate = pairedDeltaEstimate(CELLS);
    expect(estimate.n).toBe(2);
    const alpha = estimate.perTask.find((t) => t.taskId === "alpha")!;
    expect(alpha.meanA).toBeCloseTo(0.5, 10);
    expect(alpha.meanB).toBeCloseTo(0.5, 10);
    expect(alpha.delta).toBeCloseTo(0, 10);
    expect(alpha.samplingVariance).toBeCloseTo(0.5, 10);
    const gamma = estimate.perTask.find((t) => t.taskId === "gamma")!;
    expect(gamma.delta).toBeCloseTo(1, 10);
    expect(gamma.samplingVariance).toBeCloseTo(0, 10);
    expect(estimate.mean).toBeCloseTo(0.5, 10);
    expect(estimate.sd).toBeCloseTo(Math.SQRT1_2, 10);
    expect(estimate.se).toBeCloseTo(0.5, 10);
    // df = 1 → t critical 12.706
    expect(estimate.tCritical).toBeCloseTo(12.706, 3);
    expect(estimate.ci95.lower).toBeCloseTo(0.5 - 12.706 * 0.5, 3);
    expect(estimate.ci95.upper).toBeCloseTo(0.5 + 12.706 * 0.5, 3);
  });

  it("refuses a task that is missing one of the two arms", () => {
    expect(() => pairedDeltaEstimate([cell("solo", "A-native-skill", 0, 1)]))
      .toThrow(/solo has no B-flat-claude-md cells/u);
  });

  it("refuses fewer than two tasks", () => {
    expect(() => pairedDeltaEstimate([
      cell("solo", "A-native-skill", 0, 1), cell("solo", "B-flat-claude-md", 0, 0),
    ])).toThrow(/at least two tasks/u);
  });
});

describe("varianceDecomposition", () => {
  it("splits between-task variance into sampling noise and task heterogeneity", () => {
    const decomposition = varianceDecomposition(pairedDeltaEstimate(CELLS));
    expect(decomposition.betweenTaskVariance).toBeCloseTo(0.5, 10);
    expect(decomposition.meanSamplingVariance).toBeCloseTo(0.25, 10);
    expect(decomposition.taskHeterogeneity).toBeCloseTo(0.25, 10);
    expect(decomposition.heterogeneityShare).toBeCloseTo(0.5, 10);
  });

  it("floors heterogeneity at zero when noise explains everything", () => {
    const noisy: SkillsBenchDemo1AdmittedCell[] = [
      cell("p", "A-native-skill", 0, 1), cell("p", "A-native-skill", 1, 0),
      cell("p", "B-flat-claude-md", 0, 0), cell("p", "B-flat-claude-md", 1, 1),
      cell("q", "A-native-skill", 0, 1), cell("q", "A-native-skill", 1, 0),
      cell("q", "B-flat-claude-md", 0, 0), cell("q", "B-flat-claude-md", 1, 1),
    ];
    const decomposition = varianceDecomposition(pairedDeltaEstimate(noisy));
    expect(decomposition.taskHeterogeneity).toBe(0);
  });
});

describe("manipulationCheck", () => {
  it("reports arm C against the instructed arms", () => {
    const check = manipulationCheck(CELLS);
    expect(check.cCells).toBe(2);
    expect(check.cFullPass).toBe(0);
    expect(check.cMean).toBeCloseTo(0, 10);
    expect(check.abMean).toBeCloseTo(0.5, 10);
    expect(check.uplift).toBeCloseTo(0.5, 10);
  });

  it("refuses when no C cells are present", () => {
    expect(() => manipulationCheck(CELLS.filter((c) => c.arm !== "C-no-instructions")))
      .toThrow(/no C-no-instructions cells/u);
  });
});
