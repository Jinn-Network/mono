/**
 * Pure statistics for the per-codeDigest revert decision (issue #764).
 *
 * Two-proportion z-test on pass/total for "arm A" (codeDigest WITH a candidate
 * Improve commit) vs "arm B" (codeDigest AT the commit's parent). No I/O; unit-
 * tested directly with hand-computed z-values. `delta = pA - pB` (negative means
 * the commit made the pass rate worse).
 */

export interface TwoProportionInput {
  passesA: number;
  totalA: number;
  passesB: number;
  totalB: number;
}

export interface TwoProportionResult {
  /** pA - pB (negative => arm A is worse). */
  delta: number;
  /** Test statistic; sign matches `delta`. 0 when either arm has no samples. */
  z: number;
  /** Two-sided p-value in [0, 1]. 1 when there is no signal. */
  pValue: number;
}

/** Two-proportion z-test. Returns no-signal (z=0, p=1) if either total is 0. */
export function twoProportionZTest(input: TwoProportionInput): TwoProportionResult {
  const { passesA, totalA, passesB, totalB } = input;
  if (totalA <= 0 || totalB <= 0) {
    const pA = totalA > 0 ? passesA / totalA : 0;
    const pB = totalB > 0 ? passesB / totalB : 0;
    return { delta: pA - pB, z: 0, pValue: 1 };
  }
  const pA = passesA / totalA;
  const pB = passesB / totalB;
  const delta = pA - pB;
  const pooled = (passesA + passesB) / (totalA + totalB);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / totalA + 1 / totalB));
  if (se === 0) {
    // Both arms 0% or both 100% — no measurable difference.
    return { delta, z: 0, pValue: 1 };
  }
  const z = delta / se;
  const pValue = 2 * (1 - standardNormalCdf(Math.abs(z)));
  return { delta, z, pValue };
}

/** Standard normal CDF via the Abramowitz & Stegun 7.1.26 erf approximation. */
function standardNormalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function erf(x: number): number {
  // Abramowitz & Stegun 7.1.26, max abs error ~1.5e-7.
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
