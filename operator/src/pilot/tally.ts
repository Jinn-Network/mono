import { nonInferiorityVerdict, pairedCostVerdict, type TaskRates } from '../eval/capability-stats.js';

export interface SolveOutcome {
  instance_id: string;
  arm: string;
  repeat: number;
  passed: boolean | null;
  costUsd: number;
}

export interface PilotArmReport {
  resolveRate: number;
  graded: number;
  passed: number;
}

export interface PilotComparisonReport {
  baselineArm: string;
  treatmentArm: string;
  bothSolveTasks: number;
  excluded: number;
  quality: { lowerBound: number; nonInferior: boolean; deltaPP: number };
  /** `n` is the both-solve NON-ZERO cost-diff count the Wilcoxon actually uses;
   *  `underpowered` marks n below its one-sided minimum-rejectable size (~5), so a
   *  tiny-n verdict is not mistaken for a powered one. */
  cost: { verdict: 'lower' | 'not-lower' | 'inconclusive'; medianDeltaUsd: number; n: number; underpowered: boolean };
}

export interface PilotReport {
  n: number;
  baselineArm: string;
  arms: Record<string, PilotArmReport>;
  comparisons: Record<string, PilotComparisonReport>;
}

/** One-sided Wilcoxon signed-rank cannot reject below ~5 non-zero diffs
 *  (1/2^n >= alpha for n < 5), so a 'lower'/'not-lower' verdict on fewer is unpowered. */
const WILCOXON_MIN_REJECTABLE_N = 5;

function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function meanPassedCost(xs: SolveOutcome[]): number {
  const passed = xs.filter((o) => o.passed === true);
  return passed.length ? passed.reduce((s, o) => s + o.costUsd, 0) / passed.length : NaN;
}

export function tallyPilot(
  outcomes: SolveOutcome[],
  opts: { rng: () => number; baselineArm?: string },
): PilotReport {
  const armOrder: string[] = [];
  for (const outcome of outcomes) {
    if (!armOrder.includes(outcome.arm)) armOrder.push(outcome.arm);
  }
  const baselineArm = opts.baselineArm ?? armOrder[0] ?? 'stock';

  const byTask = new Map<string, SolveOutcome[]>();
  for (const o of outcomes) {
    (byTask.get(o.instance_id) ?? byTask.set(o.instance_id, []).get(o.instance_id)!).push(o);
  }

  const arms: Record<string, PilotArmReport> = {};
  for (const arm of armOrder) {
    const graded = outcomes.filter((o) => o.arm === arm && o.passed !== null);
    const passed = graded.filter((o) => o.passed === true);
    arms[arm] = {
      resolveRate: graded.length > 0 ? passed.length / graded.length : 0,
      graded: graded.length,
      passed: passed.length,
    };
  }

  const comparisons: Record<string, PilotComparisonReport> = {};
  for (const treatmentArm of armOrder.filter((arm) => arm !== baselineArm)) {
    const rates: TaskRates[] = [];
    const costDiffs: number[] = [];
    let excluded = 0;
    let bothSolveTasks = 0;

    for (const [, os] of byTask) {
      const baseline = os.filter((o) => o.arm === baselineArm);
      const treatment = os.filter((o) => o.arm === treatmentArm);
      const gradedBaseline = baseline.filter((o) => o.passed !== null);
      const gradedTreatment = treatment.filter((o) => o.passed !== null);
      if (gradedBaseline.length === 0 || gradedTreatment.length === 0) {
        excluded++;
        continue;
      }

      const pA = gradedBaseline.filter((o) => o.passed === true).length / gradedBaseline.length;
      const pB = gradedTreatment.filter((o) => o.passed === true).length / gradedTreatment.length;
      rates.push({ pA, pB });

      // both-solve cost: mean cost on repeats where BOTH arms passed (like-for-like)
      if (pA > 0 && pB > 0) {
        const ca = meanPassedCost(gradedBaseline);
        const cb = meanPassedCost(gradedTreatment);
        if (Number.isFinite(ca) && Number.isFinite(cb)) {
          costDiffs.push(cb - ca);
          bothSolveTasks++;
        }
      }
    }

    // All comparison figures come from the PAIRED task subset (tasks graded in
    // both arms). Pooled per-arm rates over every graded outcome live in `arms`
    // for display; mixing them in here lets asymmetric ungradeables shift the
    // deltas independently of the paired lowerBound.
    const pairedBaselineRate = rates.length ? rates.reduce((s, r) => s + r.pA, 0) / rates.length : 0;
    const pairedTreatmentRate = rates.length ? rates.reduce((s, r) => s + r.pB, 0) / rates.length : 0;
    const ni = rates.length
      ? nonInferiorityVerdict(rates, { rng: opts.rng, stockBaseRate: Math.max(pairedBaselineRate, 1e-9) })
      : { pass: false, lowerBound: NaN, relativeRegression: NaN, reasons: ['no gradeable pairs'] } as ReturnType<typeof nonInferiorityVerdict>;
    const cost = pairedCostVerdict(costDiffs, { minN: 1 });

    comparisons[treatmentArm] = {
      baselineArm,
      treatmentArm,
      bothSolveTasks,
      excluded,
      quality: {
        lowerBound: ni.lowerBound,
        nonInferior: ni.pass,
        deltaPP: 100 * (pairedTreatmentRate - pairedBaselineRate),
      },
      cost: {
        verdict: cost.verdict,
        medianDeltaUsd: median(costDiffs),
        n: cost.n,
        underpowered: cost.n < WILCOXON_MIN_REJECTABLE_N,
      },
    };
  }

  return {
    n: byTask.size,
    baselineArm,
    arms,
    comparisons,
  };
}
