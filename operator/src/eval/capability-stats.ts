export interface TaskRates { pA: number; pB: number; }

export interface RateCIOpts { rng: () => number; alpha?: number; resamples?: number; }

/** One-sided lower confidence bound for mean(Δ_i), Δ_i = pB - pA, via a
 *  bias-corrected bootstrap over tasks (BCa without acceleration; acceleration
 *  adds a jackknife pass — see §6.2, deferred as a refinement). */
export function pairedRateDiffLowerBound(rates: TaskRates[], opts: RateCIOpts): number {
  const alpha = opts.alpha ?? 0.05;
  const B = opts.resamples ?? 10_000;
  const n = rates.length;
  if (n === 0) throw new Error('pairedRateDiffLowerBound: empty sample');
  const deltas = rates.map((r) => r.pB - r.pA);
  const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
  const observed = mean(deltas);

  const means: number[] = [];
  for (let b = 0; b < B; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += deltas[Math.min(n - 1, Math.floor(opts.rng() * n))]!;
    means.push(s / n);
  }
  means.sort((a, b) => a - b);

  // Bias-correction z0 = Φ⁻¹(fraction of resamples < observed).
  const below = means.filter((m) => m < observed).length;
  const z0 = invNorm(Math.min(Math.max(below / B, 1e-6), 1 - 1e-6));
  const zAlpha = invNorm(alpha); // one-sided lower
  const adj = normCdf(2 * z0 + zAlpha);
  const idx = Math.min(B - 1, Math.max(0, Math.floor(adj * B)));
  return means[idx]!;
}

export interface NIOpts extends RateCIOpts { deltaAbs?: number; relativeCap?: number; stockBaseRate: number; }

export function nonInferiorityVerdict(rates: TaskRates[], opts: NIOpts): {
  pass: boolean; lowerBound: number; deltaAbs: number; relativeRegression: number; reasons: string[];
} {
  const deltaAbs = opts.deltaAbs ?? 0.05;
  const relativeCap = opts.relativeCap ?? 0.15;
  const lowerBound = pairedRateDiffLowerBound(rates, opts);
  const meanA = rates.reduce((s, r) => s + r.pA, 0) / rates.length;
  const meanB = rates.reduce((s, r) => s + r.pB, 0) / rates.length;
  const absRegression = Math.max(0, meanA - meanB);
  const relativeRegression = opts.stockBaseRate > 0 ? absRegression / opts.stockBaseRate : 0;

  const reasons: string[] = [];
  const absOk = lowerBound > -deltaAbs;
  if (!absOk) reasons.push(`absolute NI failed: lower bound ${lowerBound.toFixed(3)} ≤ -δ (${-deltaAbs})`);
  const relOk = relativeRegression <= relativeCap;
  if (!relOk) reasons.push(`relative guard failed: regression ${(relativeRegression * 100).toFixed(1)}% > cap ${(relativeCap * 100).toFixed(0)}%`);
  return { pass: absOk && relOk, lowerBound, deltaAbs, relativeRegression, reasons };
}

// --- normal helpers (kept local; mcnemar-power exports its own for its use) ---
function normCdf(x: number): number { return 0.5 * (1 + erf(x / Math.SQRT2)); }
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
function invNorm(p: number): number {
  // Beasley-Springer/Moro; adequate for CI index selection.
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pl = 0.02425;
  let q: number, r: number;
  if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0]!*q+c[1]!)*q+c[2]!)*q+c[3]!)*q+c[4]!)*q+c[5]!) / ((((d[0]!*q+d[1]!)*q+d[2]!)*q+d[3]!)*q+1); }
  if (p > 1 - pl) { q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0]!*q+c[1]!)*q+c[2]!)*q+c[3]!)*q+c[4]!)*q+c[5]!) / ((((d[0]!*q+d[1]!)*q+d[2]!)*q+d[3]!)*q+1); }
  q = p - 0.5; r = q * q;
  return (((((a[0]!*r+a[1]!)*r+a[2]!)*r+a[3]!)*r+a[4]!)*r+a[5]!)*q / (((((b[0]!*r+b[1]!)*r+b[2]!)*r+b[3]!)*r+b[4]!)*r+1);
}

// --- cost leg (append to capability-stats.ts) ---

/** One-sided Wilcoxon signed-rank test that the median paired difference < 0,
 *  using a normal approximation with a continuity correction. The variance is the
 *  UNTIED form sqrt(n(n+1)(2n+1)/24); the tie-correction term (−Σ(t³−t)/48, which
 *  only ever *subtracts* variance) is omitted, so the SD used here is if anything
 *  too large — that makes the test slightly HARDER to reject (conservative), never
 *  wrong-direction. Ranks themselves are still tie-averaged (rankAbs). */
export function pairedCostVerdict(
  costDiffs: number[],
  opts: { minN?: number; alpha?: number } = {},
): { verdict: 'lower' | 'not-lower' | 'inconclusive'; pValue: number | null; n: number } {
  const minN = opts.minN ?? 10;
  const alpha = opts.alpha ?? 0.05;
  const nonzero = costDiffs.filter((d) => d !== 0);
  if (nonzero.length < minN) return { verdict: 'inconclusive', pValue: null, n: nonzero.length };

  const ranks = rankAbs(nonzero.map(Math.abs));
  let wMinus = 0; // sum of ranks for NEGATIVE diffs (corpus cheaper)
  let wPlus = 0;
  nonzero.forEach((d, i) => { if (d < 0) wMinus += ranks[i]!; else wPlus += ranks[i]!; });
  const n = nonzero.length;
  const meanW = (n * (n + 1)) / 4;
  const sdW = Math.sqrt((n * (n + 1) * (2 * n + 1)) / 24); // untied (conservative) form — tie term omitted, see docstring
  // Test statistic: is W+ (evidence AGAINST cheaper) improbably small?
  const z = (wPlus - meanW + 0.5) / sdW;
  const pValue = normCdfLocal(z); // one-sided: P(W+ ≤ observed)
  const verdict = pValue < alpha ? 'lower' : 'not-lower';
  return { verdict, pValue, n };
}

function rankAbs(absVals: number[]): number[] {
  const idx = absVals.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(absVals.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]!.v === idx[i]!.v) j++;
    const avg = (i + j + 2) / 2; // average rank (1-based) for ties
    for (let k = i; k <= j; k++) ranks[idx[k]!.i] = avg;
    i = j + 1;
  }
  return ranks;
}

function normCdfLocal(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x >= 0 ? 1 - p : p;
}
