/**
 * Exemplar-pair yield + task-creator metric reporting.
 * Spec §5.1, §8.
 */

import { inInformativeBand, solveRate } from './_swe-rebench-v2-guards.js';

export interface InstanceVerdictStats {
  instanceId: string;
  passes: number;
  fails: number;
  synthetic?: boolean;
  lookupFlagged?: boolean;
}

export interface ExemplarPairYieldReport {
  totalInstances: number;
  exemplarPairs: number;
  byInstance: Array<{ instanceId: string; passes: number; fails: number }>;
}

export function computeExemplarPairYield(stats: InstanceVerdictStats[]): ExemplarPairYieldReport {
  const byInstance = stats
    .filter((s) => s.passes > 0 && s.fails > 0)
    .map((s) => ({ instanceId: s.instanceId, passes: s.passes, fails: s.fails }));
  return {
    totalInstances: stats.length,
    exemplarPairs: byInstance.length,
    byInstance,
  };
}

export interface TaskCreatorMetricInput {
  minted: { trajectories: number; costUsd: number };
  baseline: { trajectories: number; costUsd: number };
  instanceStats: InstanceVerdictStats[];
}

export interface TaskCreatorMetricReport {
  distillAdmissiblePerDollarMinted: number | null;
  distillAdmissiblePerDollarBaseline: number | null;
  informativeBandInstances: number;
  lookupExcluded: number;
  kill: {
    admissionYieldBelow30Pct: boolean;
    noInBandFamily: boolean;
    costAbove3xBaseline: boolean;
  };
}

export function buildTaskCreatorMetricReport(input: TaskCreatorMetricInput): TaskCreatorMetricReport {
  const inBand = input.instanceStats.filter((s) => {
    const attempts = s.passes + s.fails;
    return inInformativeBand(solveRate(s.passes, attempts)) && !s.lookupFlagged;
  });
  const admissible = inBand.filter((s) => s.passes > 0 && s.fails > 0);
  const mintedTraj = admissible.filter((s) => s.synthetic).length;
  const baselineTraj = admissible.filter((s) => !s.synthetic).length;
  const mintedPerDollar = input.minted.costUsd > 0 ? mintedTraj / input.minted.costUsd : null;
  const baselinePerDollar = input.baseline.costUsd > 0 ? baselineTraj / input.baseline.costUsd : null;
  const admissionYield = input.instanceStats.length > 0
    ? admissible.length / input.instanceStats.length
    : 0;
  const costRatio = baselinePerDollar && mintedPerDollar && mintedPerDollar > 0
    ? (baselinePerDollar / mintedPerDollar)
    : null;
  return {
    distillAdmissiblePerDollarMinted: mintedPerDollar,
    distillAdmissiblePerDollarBaseline: baselinePerDollar,
    informativeBandInstances: inBand.length,
    lookupExcluded: input.instanceStats.filter((s) => s.lookupFlagged).length,
    kill: {
      admissionYieldBelow30Pct: admissionYield < 0.3,
      noInBandFamily: inBand.length === 0,
      costAbove3xBaseline: costRatio !== null && costRatio < 1 / 3,
    },
  };
}

/** Lookup tripwire — flag suspiciously-fast or upstream-identical solves. */
export function isLookupFlagged(args: {
  solveDurationMs: number;
  patchBytes: string;
  upstreamPatchBytes?: string;
  fastThresholdMs?: number;
}): boolean {
  const threshold = args.fastThresholdMs ?? 30_000;
  if (args.solveDurationMs < threshold) return true;
  if (args.upstreamPatchBytes && args.patchBytes === args.upstreamPatchBytes) return true;
  return false;
}
