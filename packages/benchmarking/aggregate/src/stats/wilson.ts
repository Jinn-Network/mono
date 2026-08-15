/**
 * Wilson score interval (design §9.2 `wilson@1`). Ported from `operator/src/eval/wilson.ts`
 * (adoption, not invention — design §9.2, plan M3 Task 3.2). Behaves well at the extremes (p=0,
 * p=1) and for small n, unlike the naive normal-approximation interval.
 */

/** Two-sided z for a 95% interval (1.96 ~= Phi^-1(0.975)). */
const DEFAULT_Z = 1.96;

export interface WilsonInterval {
  /** Observed point estimate, passed / scorable (0 when scorable=0). */
  p: number;
  /** Lower bound, clamped to [0, 1]. */
  lo: number;
  /** Upper bound, clamped to [0, 1]. */
  hi: number;
}

/**
 * Wilson score interval for `passed` successes out of `scorable` trials. `scorable === 0`
 * returns a degenerate `{ p: 0, lo: 0, hi: 0 }` (no NaN).
 */
export function wilsonInterval(passed: number, scorable: number, z: number = DEFAULT_Z): WilsonInterval {
  if (scorable === 0) return { p: 0, lo: 0, hi: 0 };
  const n = scorable;
  const p = passed / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  const lo = (centre - margin) / denom;
  const hi = (centre + margin) / denom;
  return { p, lo: Math.max(0, lo), hi: Math.min(1, hi) };
}
