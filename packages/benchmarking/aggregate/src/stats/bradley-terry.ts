/**
 * Bradley-Terry MLE via Zermelo's iterative scaling (design §9.2 `bradley-terry@1` — "an
 * optional module for pairwise-judged benchmarks... registered but not part of the v1 reference
 * set unless pairwise judging appears"). Not seeded by an in-repo precedent; implemented from
 * the standard closed-form fixed-point iteration so the method is registered with a real
 * `compute()`, not a stub.
 */

export interface PairwiseWin {
  readonly winner: string;
  readonly loser: string;
}

export interface BradleyTerryResult {
  readonly strengths: Readonly<Record<string, number>>;
  readonly iterations: number;
  readonly converged: boolean;
}

/**
 * Fits Bradley-Terry strengths (normalized so they sum to 1) over pairwise win records via
 * Zermelo's iterative scaling: `pi_i <- w_i / sum_{j != i} n_ij / (pi_i + pi_j)`, repeated until
 * the maximum per-item change drops below `tolerance` or `maxIterations` is reached.
 */
export function fitBradleyTerry(
  wins: readonly PairwiseWin[],
  opts: { maxIterations?: number; tolerance?: number } = {},
): BradleyTerryResult {
  const maxIterations = opts.maxIterations ?? 1000;
  const tolerance = opts.tolerance ?? 1e-10;

  const items = [...new Set(wins.flatMap((w) => [w.winner, w.loser]))].sort();
  if (items.length === 0) return { strengths: {}, iterations: 0, converged: true };
  if (items.length === 1) return { strengths: { [items[0]!]: 1 }, iterations: 0, converged: true };

  const winsFor = new Map<string, number>(items.map((item) => [item, 0]));
  const gamesBetween = new Map<string, Map<string, number>>(items.map((item) => [item, new Map()]));
  for (const { winner, loser } of wins) {
    winsFor.set(winner, (winsFor.get(winner) ?? 0) + 1);
    const row = gamesBetween.get(winner)!;
    row.set(loser, (row.get(loser) ?? 0) + 1);
    const otherRow = gamesBetween.get(loser)!;
    otherRow.set(winner, (otherRow.get(winner) ?? 0) + 1);
  }

  let strengths = new Map<string, number>(items.map((item) => [item, 1 / items.length]));
  let iterations = 0;
  let converged = false;
  for (; iterations < maxIterations; iterations += 1) {
    const next = new Map<string, number>();
    for (const item of items) {
      let denominator = 0;
      for (const [opponent, games] of gamesBetween.get(item)!) {
        denominator += games / (strengths.get(item)! + strengths.get(opponent)!);
      }
      next.set(item, denominator > 0 ? (winsFor.get(item) ?? 0) / denominator : strengths.get(item)!);
    }
    const total = [...next.values()].reduce((sum, v) => sum + v, 0);
    for (const item of items) next.set(item, next.get(item)! / total);

    let maxDelta = 0;
    for (const item of items) maxDelta = Math.max(maxDelta, Math.abs(next.get(item)! - strengths.get(item)!));
    strengths = next;
    if (maxDelta < tolerance) {
      converged = true;
      iterations += 1;
      break;
    }
  }

  return { strengths: Object.fromEntries(strengths), iterations, converged };
}
