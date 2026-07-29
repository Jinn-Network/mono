/**
 * Clustering utility (design §9.2): groups items by a caller-supplied key. The design's
 * requirement — "the clustering key is pinned to the task provenance source... and is not a
 * report-time parameter" — is enforced by construction, not by this function: no `parameters`
 * value ever reaches here as a key. The paired method derives the key from the exact,
 * digest-bound Task record's `payload.provenance.source`; an absent or malformed source is a
 * typed refusal rather than a caller-selected fallback.
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
