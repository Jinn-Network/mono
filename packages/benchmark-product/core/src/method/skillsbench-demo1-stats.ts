import type { SkillsBenchDemo1AdmittedCell } from "./skillsbench-demo1-declaration.js";

/**
 * The pre-declared Demo-1 analysis: a paired per-task A−B contrast, a decomposition of its
 * variance into replicate noise versus real task-to-task heterogeneity, and the manipulation
 * check that gives the contrast its meaning.
 *
 * Everything here is a pure function of admitted cells. Nothing reaches outside its arguments,
 * so a reader can replay the numbers from the sealed evidence alone.
 */

/** Two-sided 97.5% Student-t quantiles by degrees of freedom; the normal value beyond the table. */
const T_CRITICAL: Record<number, number> = {
  1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306,
  9: 2.262, 10: 2.228, 11: 2.201, 12: 2.179, 13: 2.16, 14: 2.145, 15: 2.131,
  16: 2.12, 17: 2.11, 18: 2.101, 19: 2.093, 20: 2.086, 25: 2.06, 30: 2.042,
};

function tCriticalFor(degreesOfFreedom: number): number {
  if (degreesOfFreedom <= 0) throw new TypeError("degrees of freedom must be positive");
  const exact = T_CRITICAL[degreesOfFreedom];
  if (exact !== undefined) return exact;
  const keys = Object.keys(T_CRITICAL).map(Number).sort((a, b) => a - b);
  const below = keys.filter((k) => k < degreesOfFreedom).pop();
  return below === undefined ? 1.96 : degreesOfFreedom > 30 ? 1.96 : T_CRITICAL[below]!;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Sample variance (n−1 divisor); zero for a single observation, which understates and is disclosed. */
function sampleVariance(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const center = mean(values);
  return values.reduce((sum, value) => sum + (value - center) ** 2, 0) / (values.length - 1);
}

export interface SkillsBenchDemo1TaskDelta {
  readonly taskId: string;
  readonly meanA: number;
  readonly meanB: number;
  readonly delta: number;
  readonly replicatesA: number;
  readonly replicatesB: number;
  /** Estimated sampling variance of this task's delta: s²A/nA + s²B/nB. */
  readonly samplingVariance: number;
}

export interface SkillsBenchDemo1PairedEstimate {
  readonly perTask: readonly SkillsBenchDemo1TaskDelta[];
  readonly n: number;
  readonly mean: number;
  readonly sd: number;
  readonly se: number;
  readonly tCritical: number;
  readonly ci95: { readonly lower: number; readonly upper: number };
}

export function pairedDeltaEstimate(
  cells: readonly SkillsBenchDemo1AdmittedCell[],
): SkillsBenchDemo1PairedEstimate {
  const byTask = new Map<string, { a: number[]; b: number[] }>();
  for (const cell of cells) {
    if (cell.arm === "C-no-instructions") continue;
    const entry = byTask.get(cell.taskId) ?? { a: [], b: [] };
    (cell.arm === "A-native-skill" ? entry.a : entry.b).push(cell.rewardValue);
    byTask.set(cell.taskId, entry);
  }

  const perTask: SkillsBenchDemo1TaskDelta[] = [];
  for (const [taskId, { a, b }] of [...byTask.entries()].sort(([l], [r]) => (l < r ? -1 : 1))) {
    if (a.length === 0) throw new TypeError(`${taskId} has no A-native-skill cells`);
    if (b.length === 0) throw new TypeError(`${taskId} has no B-flat-claude-md cells`);
    perTask.push({
      taskId,
      meanA: mean(a),
      meanB: mean(b),
      delta: mean(a) - mean(b),
      replicatesA: a.length,
      replicatesB: b.length,
      samplingVariance: sampleVariance(a) / a.length + sampleVariance(b) / b.length,
    });
  }
  if (perTask.length < 2) throw new TypeError("paired estimate needs at least two tasks");

  const deltas = perTask.map((task) => task.delta);
  const center = mean(deltas);
  const sd = Math.sqrt(sampleVariance(deltas));
  const se = sd / Math.sqrt(deltas.length);
  const tCritical = tCriticalFor(deltas.length - 1);
  return {
    perTask,
    n: perTask.length,
    mean: center,
    sd,
    se,
    tCritical,
    ci95: { lower: center - tCritical * se, upper: center + tCritical * se },
  };
}

export interface SkillsBenchDemo1VarianceDecomposition {
  /** Observed variance of the per-task deltas (n−1 divisor). */
  readonly betweenTaskVariance: number;
  /** Average estimated sampling variance of a task's delta — the replicate-noise floor. */
  readonly meanSamplingVariance: number;
  /** Method-of-moments excess: max(0, between − sampling). Real task-to-task heterogeneity. */
  readonly taskHeterogeneity: number;
  /** Share of the observed between-task variance not explained by replicate noise. */
  readonly heterogeneityShare: number;
}

export function varianceDecomposition(
  estimate: SkillsBenchDemo1PairedEstimate,
): SkillsBenchDemo1VarianceDecomposition {
  const betweenTaskVariance = estimate.sd ** 2;
  const meanSamplingVariance = mean(estimate.perTask.map((task) => task.samplingVariance));
  const taskHeterogeneity = Math.max(0, betweenTaskVariance - meanSamplingVariance);
  return {
    betweenTaskVariance,
    meanSamplingVariance,
    taskHeterogeneity,
    heterogeneityShare: betweenTaskVariance === 0 ? 0 : taskHeterogeneity / betweenTaskVariance,
  };
}

export interface SkillsBenchDemo1ManipulationCheck {
  readonly cCells: number;
  readonly cFullPass: number;
  readonly cMean: number;
  /** Mean over tasks of (meanA + meanB) / 2, restricted to tasks that have C cells. */
  readonly abMean: number;
  readonly uplift: number;
}

export function manipulationCheck(
  cells: readonly SkillsBenchDemo1AdmittedCell[],
): SkillsBenchDemo1ManipulationCheck {
  const c = cells.filter((cell) => cell.arm === "C-no-instructions");
  if (c.length === 0) throw new TypeError("no C-no-instructions cells to check against");
  const cTasks = new Set(c.map((cell) => cell.taskId));
  const estimate = pairedDeltaEstimate(cells.filter((cell) => cTasks.has(cell.taskId)));
  const abMean = mean(estimate.perTask.map((task) => (task.meanA + task.meanB) / 2));
  const cMean = mean(c.map((cell) => cell.rewardValue));
  return {
    cCells: c.length,
    cFullPass: c.filter((cell) => cell.fullPass).length,
    cMean,
    abMean,
    uplift: abMean - cMean,
  };
}
