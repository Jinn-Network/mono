import { compareCodeUnitStrings } from "@jinn-network/benchmarking-records";

export type CleanSubsetBasis = "self-declared" | "announcement-anchored";

export interface CleanSubsetFilterResult {
  readonly kept: readonly string[];
  readonly excludedByPredicate: readonly string[];
}

/**
 * `clean-subset@1`'s contamination filter (design §9.2): restricts to task digests whose
 * provenance timestamp is at or after `cutoff` — the "clean" direction is items postdating a
 * model's knowledge cutoff, guaranteed not seen during training; items with no resolvable
 * timestamp are conservatively excluded (never assumed clean). `basis` is not interpreted here —
 * it is disclosed data, carried through by the caller into `results.basis`, per §9.2 ("Reports
 * carry the basis in parameters; consumers weigh accordingly" — this function does not weigh
 * `self-declared` vs `announcement-anchored` differently, since it never sees discovery-anchored
 * timestamps itself; the caller resolves whichever basis it declares before calling this).
 */
export function filterByCutoff(
  taskDigests: readonly string[],
  cutoff: string,
  resolveTimestamp: (taskDigest: string) => string | undefined,
): CleanSubsetFilterResult {
  const cutoffMs = Date.parse(cutoff);
  if (Number.isNaN(cutoffMs)) throw new Error(`filterByCutoff: cutoff is not a valid RFC 3339 timestamp: ${cutoff}`);

  const kept: string[] = [];
  const excludedByPredicate: string[] = [];
  for (const taskDigest of taskDigests) {
    const timestamp = resolveTimestamp(taskDigest);
    const timestampMs = timestamp === undefined ? Number.NaN : Date.parse(timestamp);
    if (!Number.isNaN(timestampMs) && timestampMs >= cutoffMs) kept.push(taskDigest);
    else excludedByPredicate.push(taskDigest);
  }
  kept.sort(compareCodeUnitStrings);
  excludedByPredicate.sort(compareCodeUnitStrings);
  return { kept, excludedByPredicate };
}
