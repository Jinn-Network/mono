/**
 * Clustering utility (design §9.2): groups items by a caller-supplied key. The design's
 * requirement — "the clustering key is pinned to the task provenance source... and is not a
 * report-time parameter" — is enforced by construction, not by this function: no `parameters`
 * value ever reaches here as a key (see `paired-mcnemar.ts`, which only accepts a key through
 * `MethodComputeInput.resolveClusterKey`, an injected port, never through `parameters`). A task
 * with no resolvable cluster key clusters with itself alone (its own digest as the key) — the
 * conservative default that never *manufactures* a shared cluster the resolver did not assert.
 */
export function clusterBy<T>(items: readonly T[], keyFor: (item: T) => string): Map<string, T[]> {
  const clusters = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFor(item);
    const bucket = clusters.get(key);
    if (bucket) bucket.push(item);
    else clusters.set(key, [item]);
  }
  return clusters;
}
