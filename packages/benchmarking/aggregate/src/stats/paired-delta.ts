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
  /** Unique xorshift32-v1 draws in the shared bootstrap ensemble. */
  readonly draws: number;
  readonly clusters: readonly {
    readonly key: readonly ["source" | "sourceCommitment", string];
    readonly members: readonly string[];
  }[];
}

function sameClusterManifest(
  lower: PairedDeltaIntervalResult["clusters"],
  upper: PairedDeltaIntervalResult["clusters"],
): boolean {
  if (lower.length !== upper.length) return false;
  return lower.every((cluster, clusterIndex) => {
    const candidate = upper[clusterIndex];
    if (candidate === undefined
      || cluster.key[0] !== candidate.key[0]
      || cluster.key[1] !== candidate.key[1]
      || cluster.members.length !== candidate.members.length) return false;
    return cluster.members.every((member, memberIndex) => member === candidate.members[memberIndex]);
  });
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
  if (lower.draws !== upper.draws) {
    throw new Error("clusteredPairedDeltaInterval: endpoint passes disagree on draw count");
  }
  if (!Object.is(lower.observed, upper.observed)) {
    throw new Error("clusteredPairedDeltaInterval: endpoint passes disagree on observed value");
  }
  if (!sameClusterManifest(lower.clusters, upper.clusters)) {
    throw new Error("clusteredPairedDeltaInterval: endpoint passes disagree on cluster manifest");
  }
  return {
    delta: lower.observed,
    low: lower.lowerBound,
    high: upper.lowerBound,
    unit: "source-cluster",
    draws: lower.draws,
    clusters: lower.clusters,
  };
}
