import { clusterBy } from "./clustering.js";

/**
 * Exact two-sided McNemar p-value for discordant counts `b` (improvements) and `c`
 * (regressions). Adopted from `packages/core/src/paired.ts`'s `mcnemarExact`, with the same
 * exact-binomial definition and a log-scaled tail recurrence to avoid seed-term underflow.
 * Under H0 each discordant pair is an independent fair coin, so
 * the count of one direction is Binomial(n=b+c, 0.5); the two-sided p is
 * `2 * P(X <= min(b,c))`, capped at 1.
 */
export function mcnemarExact(b: number, c: number): number {
  if (!Number.isSafeInteger(b) || !Number.isSafeInteger(c) || b < 0 || c < 0) {
    throw new Error("mcnemarExact: discordant counts must be nonnegative integers");
  }
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  // For the central lower tail, symmetry makes the capped two-sided value exactly one.
  if (k === Math.floor(n / 2)) return 1;

  // Anchor the recurrence at its largest lower-tail term, C(n,k)/2^n. The old recurrence
  // started at 2^-n, which can underflow to zero even when the full lower tail is representable.
  let logTermAtK = -n * Math.LN2;
  for (let i = 1; i <= k; i += 1) {
    logTermAtK += Math.log(n - k + i) - Math.log(i);
  }
  let relativeTerm = 1;
  let relativeCdf = 1;
  for (let i = k; i >= 1; i -= 1) {
    relativeTerm *= i / (n - i + 1);
    relativeCdf += relativeTerm;
  }
  const logTwoSided = Math.LN2 + logTermAtK + Math.log(relativeCdf);
  return logTwoSided >= 0 ? 1 : Math.exp(logTwoSided);
}

export interface DiscordantPair {
  readonly clusterKey: string;
  /** +1: improved (baseline fail, candidate pass). -1: regressed. 0: concordant (never included
   * by `pairedMcnemar` below, but tolerated here for direct callers). */
  readonly delta: -1 | 0 | 1;
}

export interface ClusteredVariance {
  readonly naiveVariance: number;
  readonly clusteredVariance: number;
  /** clusteredVariance / naiveVariance (1 when every cluster is a singleton, or naiveVariance is
   * 0 -- no discordant pairs to have a design effect over). */
  readonly designEffect: number;
  readonly clusters: number;
}

/**
 * Cluster-robust ("sandwich") variance for the paired discordant-pair mean, in the spirit of the
 * design's "Miller 2024 correction" citation (Evan Miller, "Adding Error Bars to Evals", Aug
 * 2024): naive McNemar treats each item as an independent Bernoulli trial
 * (`naiveVariance = sum(delta_i^2) = b + c`); when items cluster (e.g. by repository) and errors
 * correlate within a cluster, the correct variance is the sum of *per-cluster* discordant totals,
 * squared (`clusteredVariance = sum_g (sum_{i in g} delta_i)^2`) — algebraically the standard
 * cluster-robust (Liang & Zeger 1986 sandwich) variance estimator for a mean. `designEffect >= 1`
 * whenever clusters are non-trivial and errors within a cluster tend to agree in sign; the exact
 * numeric correspondence to Miller's published formula is not independently verified against the
 * source paper (residual, named per this repo's own disclosure convention — see this package's
 * README).
 */
export function clusteredVariance(pairs: readonly DiscordantPair[]): ClusteredVariance {
  const discordant = pairs.filter((pair) => pair.delta !== 0);
  const naiveVariance = discordant.reduce((sum, pair) => sum + pair.delta * pair.delta, 0);
  const clusters = clusterBy(discordant, (pair) => pair.clusterKey);
  let clusteredVarianceTotal = 0;
  for (const bucket of clusters.values()) {
    const clusterSum = bucket.reduce((sum, pair) => sum + pair.delta, 0);
    clusteredVarianceTotal += clusterSum * clusterSum;
  }
  return {
    naiveVariance,
    clusteredVariance: clusteredVarianceTotal,
    designEffect: naiveVariance > 0 ? clusteredVarianceTotal / naiveVariance : 1,
    clusters: clusters.size,
  };
}

function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
function normCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

export interface PairedMcnemarResult {
  readonly pairs: number;
  readonly improved: number;
  readonly regressed: number;
  readonly concordantPass: number;
  readonly concordantFail: number;
  readonly pValue: number;
  readonly clustering: { readonly basis: "task-provenance-source" | "none"; readonly clusters: number };
  /** Present only when `clustering.basis === "task-provenance-source"` (a resolver was supplied). */
  readonly clusteredPValue?: number;
  readonly designEffect?: number;
}

/**
 * `paired-mcnemar@1` (design §9.2): two-arm comparison by per-task paired differences on shared
 * Task digests. `outcomes` carries one entry per paired task: `baseline`/`candidate` each
 * `"pass" | "fail"`. When `clusterKeyFor` is supplied, a cluster-robust companion p-value is
 * computed alongside the exact test (never replacing it); when absent, `clustering.basis` is
 * honestly reported `"none"` rather than silently computing an unlabeled naive result.
 */
export function pairedMcnemar(
  outcomes: readonly { taskDigest: string; baseline: "pass" | "fail"; candidate: "pass" | "fail" }[],
  clusterKeyFor?: (taskDigest: string) => string | undefined,
): PairedMcnemarResult {
  let improved = 0;
  let regressed = 0;
  let concordantPass = 0;
  let concordantFail = 0;
  const discordant: DiscordantPair[] = [];
  for (const outcome of outcomes) {
    if (outcome.baseline === "fail" && outcome.candidate === "pass") {
      improved += 1;
      discordant.push({ clusterKey: clusterKeyFor?.(outcome.taskDigest) ?? outcome.taskDigest, delta: 1 });
    } else if (outcome.baseline === "pass" && outcome.candidate === "fail") {
      regressed += 1;
      discordant.push({ clusterKey: clusterKeyFor?.(outcome.taskDigest) ?? outcome.taskDigest, delta: -1 });
    } else if (outcome.baseline === "pass" && outcome.candidate === "pass") {
      concordantPass += 1;
    } else {
      concordantFail += 1;
    }
  }
  const pValue = mcnemarExact(improved, regressed);

  if (clusterKeyFor === undefined) {
    return {
      pairs: outcomes.length,
      improved,
      regressed,
      concordantPass,
      concordantFail,
      pValue,
      clustering: { basis: "none", clusters: discordant.length },
    };
  }

  const variance = clusteredVariance(discordant);
  const z = variance.clusteredVariance > 0 ? (improved - regressed) / Math.sqrt(variance.clusteredVariance) : 0;
  const clusteredPValue = variance.clusteredVariance > 0 ? Math.min(1, 2 * (1 - normCdf(Math.abs(z)))) : 1;
  return {
    pairs: outcomes.length,
    improved,
    regressed,
    concordantPass,
    concordantFail,
    pValue,
    clustering: { basis: "task-provenance-source", clusters: variance.clusters },
    clusteredPValue,
    designEffect: variance.designEffect,
  };
}
