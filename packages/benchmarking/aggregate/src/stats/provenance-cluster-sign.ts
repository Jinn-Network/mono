import { compareCodeUnitStrings } from "@jinn-network/benchmarking-records";
import { mcnemarExact } from "./paired-mcnemar.js";

export interface ProvenanceClusterPair {
  readonly clusterKey: string;
  /** +1 means the candidate improved the Task, -1 regressed it, and 0 is concordant. */
  readonly delta: -1 | 0 | 1;
}

export interface ProvenanceClusterVote {
  readonly clusterKey: string;
  readonly taskDelta: number;
  readonly vote: "favorable" | "unfavorable" | "tied";
}

export interface ProvenanceClusterSignResult {
  readonly clusters: number;
  readonly favorable: number;
  readonly unfavorable: number;
  readonly tied: number;
  readonly nonTied: number;
  readonly pValue: number;
  readonly votes: readonly ProvenanceClusterVote[];
}

/**
 * Exact whole-provenance-cluster sign test.
 *
 * Every cluster gets one vote, regardless of its number of Tasks. Task deltas are summed inside
 * the cluster; positive/negative totals are favorable/unfavorable and zero is a tie. Ties are
 * disclosed but excluded from the exact two-sided Binomial(n, .5) calculation. `mcnemarExact`
 * implements that same exact two-sided binomial tail over two non-negative direction counts.
 */
export function provenanceClusterSign(
  pairs: readonly ProvenanceClusterPair[],
): ProvenanceClusterSignResult {
  const totals = new Map<string, number>();
  for (const pair of pairs) {
    if (typeof pair.clusterKey !== "string" || pair.clusterKey.length === 0) {
      throw new Error("provenanceClusterSign: clusterKey must be a non-empty string");
    }
    if (pair.delta !== -1 && pair.delta !== 0 && pair.delta !== 1) {
      throw new Error("provenanceClusterSign: delta must be -1, 0, or 1");
    }
    totals.set(pair.clusterKey, (totals.get(pair.clusterKey) ?? 0) + pair.delta);
  }

  const votes = [...totals.entries()]
    .sort(([left], [right]) => compareCodeUnitStrings(left, right))
    .map(([clusterKey, taskDelta]): ProvenanceClusterVote => ({
      clusterKey,
      taskDelta,
      vote: taskDelta > 0 ? "favorable" : taskDelta < 0 ? "unfavorable" : "tied",
    }));
  const favorable = votes.filter((vote) => vote.vote === "favorable").length;
  const unfavorable = votes.filter((vote) => vote.vote === "unfavorable").length;
  const tied = votes.length - favorable - unfavorable;
  const nonTied = favorable + unfavorable;
  // The unanimous boundary is both operationally important and exactly representable as a
  // binary floating-point value. Avoid the log/exp path's harmless rounding residue so six
  // uniformly favorable clusters are reported as precisely 2 / 2^6 = .03125.
  const pValue = nonTied > 0 && (favorable === 0 || unfavorable === 0)
    ? 2 ** (1 - nonTied)
    : mcnemarExact(favorable, unfavorable);
  return {
    clusters: votes.length,
    favorable,
    unfavorable,
    tied,
    nonTied,
    pValue,
    votes,
  };
}
