/**
 * `noninferiority-iut@1` (design §9.2): the capability-eval composite intersection-union gate.
 * Ported from `client/src/eval/capability-stats.ts` (adoption, not invention — the design names
 * this file as the seed, plan M3 Task 3.2). PASS requires BOTH legs to independently reject
 * their null at `alpha`: quality is non-inferior (one-sided BCa bootstrap lower bound above
 * `-deltaAbs`, AND the mean relative regression under `relativeCap`) AND cost is strictly lower
 * (one-sided Wilcoxon signed-rank on both-solve pairs). Either leg reporting insufficient data
 * makes the overall verdict INCONCLUSIVE unless the other leg has already decisively FAILed.
 */

export interface TaskRates {
  pA: number;
  pB: number;
}

export interface RateCiOptions {
  seed: number;
  alpha?: number;
  resamples?: number;
}

export interface PairedRateDiffBcaResult {
  readonly observed: number;
  readonly lowerBound: number;
  readonly acceleration: number;
  readonly biasCorrection: number;
  readonly adjustedQuantile: number;
  readonly adjustedIndex: number;
  /** Exactly one xorshift32-v1 draw per task position in every resample. */
  readonly draws: number;
}

/** Exact program §7.26 xorshift32-v1 stream. One call performs each transition with explicit
 * uint32 truncation and returns one unsigned 32-bit draw. */
export function xorshift32(seed: number): () => number {
  if (!Number.isInteger(seed) || seed <= 0 || seed > 0xffff_ffff) {
    throw new Error("xorshift32-v1 seed must be a nonzero unsigned 32-bit integer");
  }
  let state = seed >>> 0;
  return () => {
    state = (state ^ ((state << 13) >>> 0)) >>> 0;
    state = (state ^ (state >>> 17)) >>> 0;
    state = (state ^ ((state << 5) >>> 0)) >>> 0;
    return state;
  };
}

/** One-sided BCa replay details for mean(delta_i), delta_i = pB - pA. Bootstrap
 * sampling uses exactly one xorshift32-v1 uint32 draw per sampled position. The jackknife
 * acceleration pass is deterministic and consumes no PRNG draws. */
export function pairedRateDiffBca(
  rates: readonly TaskRates[],
  opts: RateCiOptions,
): PairedRateDiffBcaResult {
  const alpha = opts.alpha ?? 0.05;
  const resamples = opts.resamples ?? 10_000;
  if (!(alpha > 0 && alpha < 1)) {
    throw new Error("pairedRateDiffBca: alpha must be in (0,1)");
  }
  if (!Number.isInteger(resamples) || resamples <= 0) {
    throw new Error("pairedRateDiffBca: resamples must be a positive integer");
  }
  const n = rates.length;
  if (n === 0) throw new Error("pairedRateDiffBca: empty sample");
  const deltas = rates.map((r) => r.pB - r.pA);
  const mean = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
  const observed = mean(deltas);
  const nextU32 = xorshift32(opts.seed);

  const means: number[] = [];
  let draws = 0;
  for (let b = 0; b < resamples; b += 1) {
    let s = 0;
    for (let i = 0; i < n; i += 1) {
      const index = Math.floor((nextU32() / 4_294_967_296) * n);
      draws += 1;
      s += deltas[index]!;
    }
    means.push(s / n);
  }
  means.sort((a, b) => a - b);

  const below = means.filter((m) => m < observed).length;
  const z0 = invNorm(Math.min(Math.max(below / resamples, 1e-6), 1 - 1e-6));
  let acceleration = 0;
  if (n > 1) {
    const jackknife = deltas.map((_, omitted) => {
      let sum = 0;
      for (let index = 0; index < n; index += 1) {
        if (index !== omitted) sum += deltas[index]!;
      }
      return sum / (n - 1);
    });
    const jackknifeMean = mean(jackknife);
    const numerator = jackknife.reduce(
      (sum, estimate) => sum + Math.pow(jackknifeMean - estimate, 3),
      0,
    );
    const sumSquares = jackknife.reduce(
      (sum, estimate) => sum + Math.pow(jackknifeMean - estimate, 2),
      0,
    );
    const denominator = 6 * Math.pow(sumSquares, 1.5);
    acceleration = denominator === 0 ? 0 : numerator / denominator;
  }
  const zAlpha = invNorm(alpha);
  const zCombined = z0 + zAlpha;
  const denominator = 1 - acceleration * zCombined;
  const adjustedZ = denominator === 0
    ? (zCombined < 0 ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY)
    : z0 + zCombined / denominator;
  const adj = normCdf(adjustedZ);
  const idx = Math.min(resamples - 1, Math.max(0, Math.floor(adj * resamples)));
  return {
    observed,
    lowerBound: means[idx]!,
    acceleration,
    biasCorrection: z0,
    adjustedQuantile: adj,
    adjustedIndex: idx,
    draws,
  };
}

/** One-sided BCa lower confidence bound. */
export function pairedRateDiffLowerBound(rates: readonly TaskRates[], opts: RateCiOptions): number {
  return pairedRateDiffBca(rates, opts).lowerBound;
}

export interface NonInferiorityOptions extends RateCiOptions {
  deltaAbs?: number;
  relativeCap?: number;
  stockBaseRate?: number;
  /** Below this many paired tasks, the quality leg is inconclusive rather than a weak PASS/FAIL
   * (design §9.3 spirit: a method never manufactures confidence from too little data). */
  minN?: number;
}

export type QualityVerdict = "pass" | "fail" | "inconclusive";

export interface NonInferiorityResult {
  readonly verdict: QualityVerdict;
  readonly lowerBound: number | null;
  readonly deltaAbs: number;
  readonly relativeRegression: number | null;
  readonly reasons: readonly string[];
}

export function nonInferiorityVerdict(rates: readonly TaskRates[], opts: NonInferiorityOptions): NonInferiorityResult {
  const minN = opts.minN ?? 5;
  if (rates.length < minN) {
    return {
      verdict: "inconclusive",
      lowerBound: null,
      deltaAbs: opts.deltaAbs ?? 0.05,
      relativeRegression: null,
      reasons: [`fewer than minN=${minN} paired tasks (got ${rates.length})`],
    };
  }
  const deltaAbs = opts.deltaAbs ?? 0.05;
  const relativeCap = opts.relativeCap ?? 0.15;
  const lowerBound = pairedRateDiffLowerBound(rates, opts);
  const meanA = rates.reduce((s, r) => s + r.pA, 0) / rates.length;
  const meanB = rates.reduce((s, r) => s + r.pB, 0) / rates.length;
  const absRegression = Math.max(0, meanA - meanB);
  const stockBaseRate = opts.stockBaseRate ?? meanA;
  const relativeRegression = stockBaseRate > 0 ? absRegression / stockBaseRate : 0;

  const reasons: string[] = [];
  const absOk = lowerBound > -deltaAbs;
  if (!absOk) reasons.push(`absolute NI failed: lower bound ${lowerBound.toFixed(3)} <= -delta (${-deltaAbs})`);
  const relOk = relativeRegression <= relativeCap;
  if (!relOk) reasons.push(`relative guard failed: regression ${(relativeRegression * 100).toFixed(1)}% > cap ${(relativeCap * 100).toFixed(0)}%`);
  return { verdict: absOk && relOk ? "pass" : "fail", lowerBound, deltaAbs, relativeRegression, reasons };
}

export interface CostVerdictResult {
  readonly verdict: "lower" | "not-lower" | "inconclusive";
  readonly pValue: number | null;
  readonly n: number;
}

/** One-sided Wilcoxon signed-rank test that the median paired cost difference is < 0 (candidate
 * cheaper), using a normal approximation with a continuity correction. */
export function pairedCostVerdict(
  costDiffs: readonly number[],
  opts: { minN?: number; alpha?: number } = {},
): CostVerdictResult {
  const minN = opts.minN ?? 10;
  const alpha = opts.alpha ?? 0.05;
  const nonzero = costDiffs.filter((d) => d !== 0);
  if (nonzero.length < minN) return { verdict: "inconclusive", pValue: null, n: nonzero.length };

  const ranks = rankAbs(nonzero.map(Math.abs));
  let wPlus = 0;
  nonzero.forEach((d, i) => {
    if (d >= 0) wPlus += ranks[i]!;
  });
  const n = nonzero.length;
  const meanW = (n * (n + 1)) / 4;
  const sdW = Math.sqrt((n * (n + 1) * (2 * n + 1)) / 24);
  const z = (wPlus - meanW + 0.5) / sdW;
  const pValue = normCdf(z);
  return { verdict: pValue < alpha ? "lower" : "not-lower", pValue, n };
}

function rankAbs(absVals: readonly number[]): number[] {
  const idx = absVals.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(absVals.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]!.v === idx[i]!.v) j += 1;
    const avg = (i + j + 2) / 2;
    for (let k = i; k <= j; k += 1) ranks[idx[k]!.i] = avg;
    i = j + 1;
  }
  return ranks;
}

export type NonInferiorityIutVerdict = "PASS" | "FAIL" | "INCONCLUSIVE";

export interface NonInferiorityIutResult {
  readonly verdict: NonInferiorityIutVerdict;
  readonly quality: NonInferiorityResult;
  readonly cost: CostVerdictResult;
}

/** The intersection-union composition (design §9.2): PASS only if both legs independently
 * reject their null; a decisive FAIL on either leg dominates an inconclusive other leg. */
export function nonInferiorityIut(quality: NonInferiorityResult, cost: CostVerdictResult): NonInferiorityIutVerdict {
  if (quality.verdict === "fail" || cost.verdict === "not-lower") return "FAIL";
  if (quality.verdict === "inconclusive" || cost.verdict === "inconclusive") return "INCONCLUSIVE";
  return "PASS";
}

// --- normal helpers (kept local, ported from the seed) ---
function normCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
function invNorm(p: number): number {
  // Beasley-Springer/Moro; adequate for CI index selection.
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239e0];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0, -2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0, 3.754408661907416e0];
  const pl = 0.02425;
  let q: number, r: number;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!)
      / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p > 1 - pl) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!)
      / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  q = p - 0.5;
  r = q * q;
  return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q
    / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}
