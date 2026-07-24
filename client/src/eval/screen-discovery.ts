/**
 * Held-out screening's "already trained-on" exclusion boundary (#986).
 *
 * Returns the set of swe-rebench-v2 `instance_id`s that have been ATTEMPTED on
 * the network for a SolverNet — any verdict envelope, passed OR failed,
 * cross-operator. An attempted instance was executed by an operator, so the
 * learner trained on it; holding it out later would make a trained-checkpoint
 * pass count as memorization, not generalization.
 *
 * The local ledger only reflects THIS box and can be stale, while the current
 * indexer `verdictEnvelopeMeta` is permissionless and shape-parsed. Neither is
 * authoritative enough for an exam exclusion. This function therefore aborts
 * until the indexer materializes canonical bridge-grade verdict projections.
 *
 * Throws on indexer failure — callers MUST abort rather than screen against an
 * unknown attempted set, because a missing exclusion can silently contaminate
 * the exam (the whole point of held-out discipline).
 */

export async function fetchAttemptedInstanceIds(
  discoveryUrl: string,
  manifestCid: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Set<string>> {
  void discoveryUrl;
  void manifestCid;
  void fetchImpl;
  // A permissionless verdict projection can name any victim manifest and
  // instance, which would poison the held-out exclusion set. Screening must
  // abort—not assume an empty set—until the indexer exposes canonical
  // publisher-Safe/signature/hash/original-task-bound verdict rows.
  throw new Error(
    'held-out screening: authenticated attempted-instance projection unavailable',
  );
}
