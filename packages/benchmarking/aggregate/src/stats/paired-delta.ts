/**
 * `paired-delta@1`'s interval construction: the central two-sided BCa interval for the paired
 * mean rate difference, composed from two calls to the existing one-sided estimator.
 *
 * `clusteredPairedRateDiffBca`'s bootstrap distribution depends only on `seed` and `resamples`;
 * `alpha` enters solely at the quantile-index step. Two calls at the same seed with `alpha/2` and
 * `1 - alpha/2` therefore select the two BCa endpoints of ONE bootstrap distribution — the
 * standard BCa two-sided construction, with no new statistical mathematics and no modification
 * to the existing estimator or its pinned oracle.
 */

import { clusteredPairedRateDiffBca, type ClusteredTaskRate } from "./noninferiority.js";

export interface PairedDeltaIntervalOptions {
  readonly seed: number;
  readonly resamples: number;
  /** Two-sided significance level; the result is the central (1 - alpha) BCa interval. */
  readonly alpha: number;
}

export interface PairedDeltaIntervalResult {
  /** Observed mean over tasks of (pB - pA). */
  readonly delta: number;
  readonly low: number;
  readonly high: number;
  readonly unit: "source-cluster";
  /** Total xorshift32-v1 draws across both bootstrap passes. */
  readonly draws: number;
  readonly clusters: readonly {
    readonly key: readonly ["source" | "sourceCommitment", string];
    readonly members: readonly string[];
  }[];
}

export function clusteredPairedDeltaInterval(
  rates: readonly ClusteredTaskRate[],
  opts: PairedDeltaIntervalOptions,
): PairedDeltaIntervalResult {
  if (!(opts.alpha > 0 && opts.alpha < 1)) {
    throw new Error("clusteredPairedDeltaInterval: alpha must be in (0,1)");
  }
  const lower = clusteredPairedRateDiffBca(rates, {
    seed: opts.seed,
    resamples: opts.resamples,
    alpha: opts.alpha / 2,
  });
  const upper = clusteredPairedRateDiffBca(rates, {
    seed: opts.seed,
    resamples: opts.resamples,
    alpha: 1 - opts.alpha / 2,
  });
  return {
    delta: lower.observed,
    low: lower.lowerBound,
    high: upper.lowerBound,
    unit: "source-cluster",
    draws: lower.draws + upper.draws,
    clusters: lower.clusters,
  };
}
