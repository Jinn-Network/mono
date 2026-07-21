/**
 * Distribution signal — where is real usage concentrating (plan Task 7,
 * issue #1314; spec §7).
 *
 * v0 clustering is a **tag rollup**: an envelope's primary (first)
 * distribution tag is its cluster; the cluster's `topTags` are the other
 * tags' frequencies inside it. Deliberately crude — spec §8 says crude
 * counts are enough for v0 — and replaceable by an upstream clustering
 * endpoint without changing the output shape.
 *
 * Seeds are excluded from every number by default (`provenance:
 * 'imported'`): seeds provide day-one usefulness but are not demand. The
 * `includeSeeds` option exists for the demonstrate-it-live toggle in the
 * explorer view, never as a default.
 */

export interface SignalInput {
  /** distributionTags from the trace envelope (first tag = primary). */
  tags: string[];
  provenance: 'contributed' | 'imported' | 'derived-from-history';
  /** Contributor identity (operator Safe address). */
  contributor: string;
}

export interface SignalRow {
  cluster: string;
  envelopeCount: number;
  contributorCount: number;
  /** Co-occurring tags in the cluster, most frequent first (primary excluded). */
  topTags: string[];
}

export interface SignalOptions {
  /** Fold `provenance: 'imported'` entries back into the counts. Default false. */
  includeSeeds?: boolean;
  /** Cap on topTags per cluster. Default 5. */
  topTagsLimit?: number;
}

export function computeSignal(
  entries: SignalInput[],
  opts: SignalOptions = {},
): SignalRow[] {
  const topTagsLimit = opts.topTagsLimit ?? 5;
  const clusters = new Map<
    string,
    { envelopes: number; contributors: Set<string>; tagCounts: Map<string, number> }
  >();

  for (const entry of entries) {
    if (entry.provenance === 'imported' && !opts.includeSeeds) continue;
    const primary = entry.tags[0];
    if (!primary) continue;
    const cluster = clusters.get(primary) ?? {
      envelopes: 0,
      contributors: new Set<string>(),
      tagCounts: new Map<string, number>(),
    };
    cluster.envelopes += 1;
    cluster.contributors.add(entry.contributor);
    for (const tag of entry.tags.slice(1)) {
      cluster.tagCounts.set(tag, (cluster.tagCounts.get(tag) ?? 0) + 1);
    }
    clusters.set(primary, cluster);
  }

  return [...clusters.entries()]
    .map(([cluster, agg]) => ({
      cluster,
      envelopeCount: agg.envelopes,
      contributorCount: agg.contributors.size,
      topTags: [...agg.tagCounts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, topTagsLimit)
        .map(([tag]) => tag),
    }))
    .sort((a, b) => b.envelopeCount - a.envelopeCount || a.cluster.localeCompare(b.cluster));
}
