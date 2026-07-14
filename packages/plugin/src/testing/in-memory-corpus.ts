import type { CorpusPort } from '../ports/corpus-port.js';
import type { KnowledgeHit } from '../schemas/knowledge-hit.js';
import { ok } from '../outcome.js';

/** Map/array-backed, seedable — architecture spec §8. */
export class InMemoryCorpusPort implements CorpusPort {
  constructor(private readonly seed: KnowledgeHit[] = []) {}

  async search(query: string) {
    // Naive token-overlap match, no ranking (Stage 1 pass-through — see
    // plugin.ts's firstTurnPickup). Words under 4 chars are dropped so
    // stopwords ("how", "do", "fix") don't cause spurious matches.
    const words = query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 4);
    const hits = this.seed.filter((hit) => {
      const haystack = [hit.ref, hit.title, hit.snippet].filter((v): v is string => v != null).join(' ').toLowerCase();
      return words.length === 0 ? haystack.includes(query.toLowerCase()) : words.some((word) => haystack.includes(word));
    });
    return ok(hits);
  }

  async get(ref: string) {
    return ok(this.seed.find((hit) => hit.ref === ref) ?? null);
  }
}
