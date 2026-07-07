import { pairedRateDiffLowerBound, nonInferiorityVerdict, pairedCostVerdict, type TaskRates } from '../eval/capability-stats.js';

export interface SolveOutcome { instance_id: string; arm: 'A' | 'B'; repeat: number; passed: boolean | null; costUsd: number; }

export interface PilotReport {
  n: number;
  armA: { resolveRate: number };
  armB: { resolveRate: number };
  bothSolveTasks: number;
  excluded: number;
  quality: { lowerBound: number; nonInferior: boolean; deltaPP: number };
  cost: { verdict: 'lower' | 'not-lower' | 'inconclusive'; medianDeltaUsd: number };
}

export function tallyPilot(outcomes: SolveOutcome[], opts: { rng: () => number }): PilotReport {
  const byTask = new Map<string, SolveOutcome[]>();
  for (const o of outcomes) (byTask.get(o.instance_id) ?? byTask.set(o.instance_id, []).get(o.instance_id)!).push(o);

  const rates: TaskRates[] = [];
  const costDiffs: number[] = [];
  let excluded = 0;
  let aPassTot = 0, aTot = 0, bPassTot = 0, bTot = 0, bothSolve = 0;

  // Count excluded (ungradeable) outcomes
  for (const o of outcomes) {
    if (o.passed === null) excluded++;
  }

  for (const [, os] of byTask) {
    const A = os.filter((o) => o.arm === 'A');
    const B = os.filter((o) => o.arm === 'B');
    const gradedA = A.filter((o) => o.passed !== null);
    const gradedB = B.filter((o) => o.passed !== null);
    if (gradedA.length === 0 || gradedB.length === 0) { continue; }
    const pA = gradedA.filter((o) => o.passed === true).length / gradedA.length;
    const pB = gradedB.filter((o) => o.passed === true).length / gradedB.length;
    rates.push({ pA, pB });
    aPassTot += gradedA.filter((o) => o.passed === true).length; aTot += gradedA.length;
    bPassTot += gradedB.filter((o) => o.passed === true).length; bTot += gradedB.length;
    // both-solve cost: mean cost on the repeats where BOTH arms passed (like-for-like)
    if (pA > 0 && pB > 0) {
      const meanCost = (xs: SolveOutcome[], pass: boolean): number => {
        const f = xs.filter((o) => o.passed === pass); return f.length ? f.reduce((s, o) => s + o.costUsd, 0) / f.length : NaN;
      };
      const ca = meanCost(gradedA, true), cb = meanCost(gradedB, true);
      if (Number.isFinite(ca) && Number.isFinite(cb)) { costDiffs.push(cb - ca); bothSolve++; }
    }
  }

  const stockBaseRate = aTot > 0 ? aPassTot / aTot : 0;
  const ni = rates.length
    ? nonInferiorityVerdict(rates, { rng: opts.rng, stockBaseRate: Math.max(stockBaseRate, 1e-9) })
    : { pass: false, lowerBound: NaN, relativeRegression: NaN, reasons: ['no gradeable pairs'] } as ReturnType<typeof nonInferiorityVerdict>;
  const cost = pairedCostVerdict(costDiffs, { minN: 1 });
  const median = (xs: number[]): number => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };

  return {
    n: rates.length,
    armA: { resolveRate: stockBaseRate },
    armB: { resolveRate: bTot > 0 ? bPassTot / bTot : 0 },
    bothSolveTasks: bothSolve,
    excluded,
    quality: { lowerBound: ni.lowerBound, nonInferior: ni.pass, deltaPP: 100 * ((bTot > 0 ? bPassTot / bTot : 0) - stockBaseRate) },
    cost: { verdict: cost.verdict, medianDeltaUsd: median(costDiffs) },
  };
}
