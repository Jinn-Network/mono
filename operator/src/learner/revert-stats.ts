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

export interface MannWhitneyResult {
  /** U statistic for arm A. */
  u: number;
  /** Normal-approx z (sign matches "A − B": negative => A stochastically lower). */
  z: number;
  /** Two-sided p-value in [0, 1]; 1 when there is no signal or an arm is empty. */
  pValue: number;
}

/**
 * Mann-Whitney U (rank-sum) with tie correction and normal approximation.
 * Rank-based per the design §3 — robust to the bounded/bimodal/miscalibrated
 * graded-score distribution. No I/O. (#1019)
 */
export function mannWhitneyU(a: number[], b: number[]): MannWhitneyResult {
  const nA = a.length;
  const nB = b.length;
  if (nA === 0 || nB === 0) return { u: 0, z: 0, pValue: 1 };

  const all = [...a.map((v) => ({ v, g: 0 })), ...b.map((v) => ({ v, g: 1 }))];
  all.sort((x, y) => x.v - y.v);

  // Average ranks (1-based), tie-aware.
  const ranks = new Array(all.length).fill(0);
  let i = 0;
  let tieTerm = 0; // Σ (t³ − t) over tie groups, for the variance correction
  while (i < all.length) {
    let j = i;
    while (j + 1 < all.length && all[j + 1]!.v === all[i]!.v) j++;
    const avgRank = (i + 1 + (j + 1)) / 2;
    for (let k = i; k <= j; k++) ranks[k] = avgRank;
    const t = j - i + 1;
    if (t > 1) tieTerm += t * t * t - t;
    i = j + 1;
  }

  let rankSumA = 0;
  for (let k = 0; k < all.length; k++) if (all[k]!.g === 0) rankSumA += ranks[k]!;

  const uA = rankSumA - (nA * (nA + 1)) / 2;
  const n = nA + nB;
  const meanU = (nA * nB) / 2;
  const varU = (nA * nB / (n * (n - 1))) * ((n * n * n - n) / 12 - tieTerm / 12);
  if (varU <= 0) return { u: uA, z: 0, pValue: 1 };

  const z = (uA - meanU) / Math.sqrt(varU);
  const pValue = 2 * (1 - standardNormalCdf(Math.abs(z)));
  return { u: uA, z, pValue };
}
