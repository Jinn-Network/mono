/**
 * CorpusPort adapter (#1660) — shims `HarnessLayer.corpus` onto the plugin's
 * `CorpusPort`. `search` maps `CorpusSearchHit[]` → `KnowledgeHit[]`; `get`
 * translates the missing-manifest throw into `ok(null)` (the contract's
 * unknown-ref behaviour). Every throw becomes a typed `PortResult`.
 */
import type { CorpusPort, KnowledgeHit, PortResult } from '@jinn-network/plugin';
import { degraded, ok } from '@jinn-network/plugin';
import {
  createHarnessLayer,
  type CorpusSearchHit,
  type HarnessLayer,
  type HarnessLayerConfig,
} from '../consume.js';

export interface CorpusAdapterDeps {
  /** A ready HarnessLayer (test seam: a fake `{ corpus: { search, get } }`). */
  layer: HarnessLayer;
}

function isLayerDeps(deps: CorpusAdapterDeps | HarnessLayerConfig): deps is CorpusAdapterDeps {
  return 'layer' in deps;
}

/** `CorpusSearchHit` → `KnowledgeHit`. `summary` → `snippet`; `score` omitted. */
function toKnowledgeHit(hit: CorpusSearchHit): KnowledgeHit {
  return {
    ref: hit.ref,
    kind: hit.kind === 'skill' ? 'skill' : 'trace',
    ...(hit.title ? { title: hit.title } : {}),
    ...(hit.summary ? { snippet: hit.summary } : {}),
  };
}

/**
 * Build a CorpusPort over a HarnessLayer. Pass `{ layer }` (a real or fake
 * layer) or a `HarnessLayerConfig` (a real layer is constructed via
 * `createHarnessLayer`).
 */
export function createCorpusAdapter(deps: CorpusAdapterDeps | HarnessLayerConfig): CorpusPort {
  const layer = isLayerDeps(deps) ? deps.layer : createHarnessLayer(deps);

  return {
    async search(query: string): Promise<PortResult<KnowledgeHit[]>> {
      try {
        const hits = await layer.corpus.search(query);
        return ok(hits.map(toKnowledgeHit));
      } catch (e) {
        // Empty array keeps callers alive when discovery is unreachable.
        return degraded(`corpus search failed: ${String(e)}`, []);
      }
    },

    async get(ref: string): Promise<PortResult<KnowledgeHit | null>> {
      try {
        const record = await layer.corpus.get(ref);
        return ok({ ref: record.ref, kind: 'trace' });
      } catch {
        // `corpus.get` throws on a missing manifest, and the contract requires
        // `ok(null)` for that unknown-ref path (Stage 1). A genuine transport
        // error is currently indistinguishable from not-found via the throw, so
        // it also collapses to `ok(null)` here; distinguishing the two is a
        // follow-up on `consume.ts`'s `corpus.get` surface, not this shim.
        return ok(null);
      }
    },
  };
}
