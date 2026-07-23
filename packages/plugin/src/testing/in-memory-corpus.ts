import type { CorpusPort, CorpusRecord } from '../ports/corpus-port.js';
import type { KnowledgeHit } from '../schemas/knowledge-hit.js';
import { ok } from '../outcome.js';

/**
 * A seed record for `InMemoryCorpusPort`: a full content-bearing
 * `CorpusRecord` plus the lightweight `KnowledgeHit` metadata a real corpus
 * search would return for it (kind/title/tier/payloadKind/publishedAt — the
 * fields not derivable from `CorpusRecord` alone).
 */
export type InMemoryCorpusSeed = CorpusRecord & Pick<KnowledgeHit, 'kind'> & Partial<
  Pick<KnowledgeHit, 'title' | 'tier' | 'payloadKind' | 'publishedAt'>
>;

function toKnowledgeHit(seed: InMemoryCorpusSeed): KnowledgeHit {
  return {
    ref: seed.ref,
    ...(seed.canonicalEpisodeId !== undefined
      ? { canonicalEpisodeId: seed.canonicalEpisodeId }
      : {}),
    kind: seed.kind,
    ...(seed.title !== undefined ? { title: seed.title } : {}),
    snippet: seed.task.summary,
    ...(seed.tier !== undefined ? { tier: seed.tier } : {}),
    ...(seed.payloadKind !== undefined ? { payloadKind: seed.payloadKind } : {}),
    tags: seed.tags,
    origin: seed.origin,
    ...(seed.publishedAt !== undefined ? { publishedAt: seed.publishedAt } : {}),
    retrievalVisible: seed.retrievalVisible,
  };
}

/** Map/array-backed, seedable — architecture spec §8. Seeds carry full
 *  content (`CorpusRecord`) so `get()` can return it directly; `search()`
 *  derives the lightweight `KnowledgeHit` view. */
export class InMemoryCorpusPort implements CorpusPort {
  private readonly seed: InMemoryCorpusSeed[];

  constructor(seed: InMemoryCorpusSeed[] = []) {
    // Seeds default to retrieval-visible (#1824) so pre-allowlist scenarios
    // keep exercising their own concern; a test proving exclusion sets
    // `retrievalVisible: false` explicitly. Normalized once here so the
    // search() and get() views cannot disagree about the default.
    this.seed = seed.map((s) => ({ ...s, retrievalVisible: s.retrievalVisible ?? true }));
  }

  async search(query: string) {
    // Naive token-overlap match, no ranking — a stand-in for the real
    // corpus's capture-meta / manifest-scan search. Words under 4 chars are
    // dropped so stopwords ("how", "do", "fix") don't cause spurious matches.
    const words = query
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length >= 4);
    const hits = this.seed.filter((record) => {
      const haystack = [record.ref, record.task.summary, ...record.tags]
        .join(' ')
        .toLowerCase();
      return words.length === 0
        ? haystack.includes(query.toLowerCase())
        : words.some((word) => haystack.includes(word));
    });
    return ok(hits.map(toKnowledgeHit));
  }

  async get(ref: string) {
    const record = this.seed.find((r) => r.ref === ref);
    if (!record) return ok(null);
    // Strip the KnowledgeHit-only fields — get() returns the CorpusRecord shape.
    const { kind: _kind, title: _title, tier: _tier, payloadKind: _payloadKind, publishedAt: _publishedAt, ...corpusRecord } = record;
    return ok(corpusRecord as CorpusRecord);
  }
}
