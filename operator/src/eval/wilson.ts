/**
 * Wilson score interval + resolved-rate comparison for the `jinn eval`
 * held-out checkpoint orchestrator (issue #818, AC#2).
 *
 * The Wilson score interval is a binomial proportion confidence interval that
 * behaves well at the extremes (p=0, p=1) and for small n — unlike the naive
 * normal-approximation interval. We write it small (no stats dependency, per
 * repo convention): the formula is ~10 lines.
 *
 * Per log/decisions/2026-05-28-rl-eval-measurement.md §4: this is v1-simple.
 * Only *large* deltas are trustworthy — we encode that as "the child and
 * parent intervals do not overlap." No seed control, no multi-run averaging.
 */

/** Two-sided z for a 95% interval (1.96 ≈ Φ⁻¹(0.975)). */
const DEFAULT_Z = 1.96;

export interface Interval {
  /** Observed point estimate, passed / scorable (0 when scorable=0). */
  p: number;
  /** Lower bound, clamped to [0, 1]. */
  lo: number;
  /** Upper bound, clamped to [0, 1]. */
  hi: number;
}

/**
 * Wilson score interval for `passed` successes out of `scorable` trials.
 * `scorable === 0` returns a degenerate `{ p: 0, lo: 0, hi: 0 }` (no NaN).
 */
export function wilsonInterval(passed: number, scorable: number, z: number = DEFAULT_Z): Interval {
  if (scorable === 0) return { p: 0, lo: 0, hi: 0 };
  const n = scorable;
  const p = passed / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  const lo = (centre - margin) / denom;
  const hi = (centre + margin) / denom;
  return {
    p,
    lo: Math.max(0, lo),
    hi: Math.min(1, hi),
  };
}

export type RateVerdict = 'trustworthy' | 'within-noise';

export interface RateComparison {
  child: Interval;
  parent: Interval;
  /** child.p − parent.p (point-estimate difference, can be negative). */
  delta: number;
  /**
   * 'trustworthy' iff the two Wilson intervals do NOT overlap; otherwise
   * 'within-noise'. v1-simple: only disjoint intervals justify a claim.
   */
  verdict: RateVerdict;
}

export function compareRates(
  child: { passed: number; scorable: number },
  parent: { passed: number; scorable: number },
): RateComparison {
  const c = wilsonInterval(child.passed, child.scorable);
  const p = wilsonInterval(parent.passed, parent.scorable);
  const disjoint = c.lo > p.hi || p.lo > c.hi;
  return {
    child: c,
    parent: p,
    delta: c.p - p.p,
    verdict: disjoint ? 'trustworthy' : 'within-noise',
  };
}
