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

import { compareCodeUnitStrings } from "@jinn-network/benchmarking-records";
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

/**
 * The source-cluster manifest every clustered-paired-delta consumer publishes alongside its
 * interval (spec §7.2a: "nothing about the resampler, the cluster manifest, or the jackknife
 * acceleration is reimplemented"). Single-sourced here so `paired-delta@1`
 * (`registry.ts`, packet P5's precedent) and `paired-majority-delta@1`
 * (`paired-majority-delta-method.ts`, packet P5, issue #2837) publish the identical grouping
 * rather than two independent implementations of one published artifact. Grouping-key order
 * (source-tag then value) and member order (task-digest code-unit order) are both stable so the
 * manifest is byte-reproducible across callers and recomputes.
 */
export function sourceClusterManifest(rates: readonly {
  readonly taskDigest: string;
  readonly cluster: readonly ["source" | "sourceCommitment", string];
}[]): readonly { readonly key: readonly ["source" | "sourceCommitment", string]; readonly members: readonly string[] }[] {
  const groups = new Map<string, { key: ["source" | "sourceCommitment", string]; members: string[] }>();
  for (const rate of rates) {
    const id = JSON.stringify(rate.cluster);
    const group = groups.get(id) ?? { key: [rate.cluster[0], rate.cluster[1]], members: [] };
    group.members.push(rate.taskDigest);
    groups.set(id, group);
  }
  return [...groups.values()]
    .map((group) => ({ ...group, members: group.members.sort(compareCodeUnitStrings) }))
    .sort((left, right) => {
      const byTag = compareCodeUnitStrings(left.key[0], right.key[0]);
      return byTag === 0 ? compareCodeUnitStrings(left.key[1], right.key[1]) : byTag;
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
