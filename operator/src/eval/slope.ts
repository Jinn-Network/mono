/**
 * Ordinary least-squares slope of resolved-rate vs cycle index for the
 * train-arm slope measurement (issue #822, AC#1).
 *
 * The train-arm e2e evaluates a checkpoint against the held-out slate (#817)
 * at intervals via the eval orchestrator (#818), collecting one
 * `{ cycleIndex, rate }` point per interval (`rate` = passed / scorable, the
 * Wilson point estimate). The slope of the least-squares fit is the headline
 * "is the learner improving across the training sequence" number.
 *
 * It is deliberately a thin helper over the closed-form OLS slope
 * (`cov(x,y) / var(x)`); the per-point confidence intervals come from
 * `wilson.ts` — this module does NOT reimplement them. The slope sign alone is
 * never a verdict at small N: a flat or slightly negative slope is "within
 * noise", which the e2e surfaces via the §4.1 honesty caveat.
 */

export interface RatePoint {
  /** Training cycle index the eval ran at (0 = baseline, before any training). */
  cycleIndex: number;
  /** Observed resolved rate at that interval (passed / scorable, in [0, 1]). */
  rate: number;
}

/**
 * Least-squares slope of `rate` regressed on `cycleIndex`. Returns 0 for fewer
 * than two points (no line to fit) and for a degenerate fit where every x is
 * identical (zero variance — division would be NaN). A flat sequence yields
 * exactly 0.
 */
export function leastSquaresSlope(points: RatePoint[]): number {
  const n = points.length;
  if (n < 2) return 0;
  let sumX = 0;
  let sumY = 0;
  for (const { cycleIndex, rate } of points) {
    sumX += cycleIndex;
    sumY += rate;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  let cov = 0;
  let varX = 0;
  for (const { cycleIndex, rate } of points) {
    const dx = cycleIndex - meanX;
    cov += dx * (rate - meanY);
    varX += dx * dx;
  }
  if (varX === 0) return 0;
  return cov / varX;
}
