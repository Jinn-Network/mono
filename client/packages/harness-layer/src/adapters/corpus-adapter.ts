/**
 * CorpusPort adapter (#1660; content-bearing get() per Stage 1 rescope R2,
 * #1772) — shims `HarnessLayer.corpus` onto the plugin's `CorpusPort`.
 * `search` maps `CorpusSearchHit[]` → `KnowledgeHit[]`, carrying the
 * evidence-first selection fields (tags/origin/publishedAt) alongside the
 * pre-existing title/snippet. `get` decodes and sha256-verifies the
 * `jinn.trace-envelope.v0` artifact the same way the Python
 * `skills_install._extract_trace` path does, returning full content — not
 * metadata — or a typed degraded reason on a corrupt/unreadable record.
 */
import { createHash } from 'node:crypto';
import type { CorpusPort, CorpusRecord, KnowledgeHit, PortResult } from '@jinn-network/plugin';
import { degraded, ok } from '@jinn-network/plugin';
import {
  createHarnessLayer,
  type CorpusRecord as WireCorpusRecord,
  type CorpusSearchHit,
  type HarnessLayer,
  type HarnessLayerConfig,
} from '../consume.js';
import { parseTraceEnvelopeV0 } from '../envelope.js';
import { TRACE_ENVELOPE_ARTIFACT_TYPE } from '../publish.js';

export interface CorpusAdapterDeps {
  /** A ready HarnessLayer (test seam: a fake `{ corpus: { search, get } }`). */
  layer: HarnessLayer;
}

function isLayerDeps(deps: CorpusAdapterDeps | HarnessLayerConfig): deps is CorpusAdapterDeps {
  return 'layer' in deps;
}

/**
 * `CorpusSearchHit` → `KnowledgeHit`. `summary` → `snippet`; `score` omitted.
 * `origin` is the identity used by cross-record content dedup: prefer the
 * on-chain-derived `agentId`, otherwise use the record ref so unattributed
 * records cannot collide through a forged manifest `safeAddress`.
 */
function toKnowledgeHit(hit: CorpusSearchHit): KnowledgeHit {
  const origin = hit.operator.agentId || hit.ref;
  return {
    ref: hit.ref,
    kind: hit.kind === 'skill' ? 'skill' : 'trace',
    ...(hit.title ? { title: hit.title } : {}),
    ...(hit.summary ? { snippet: hit.summary } : {}),
    tags: hit.tags ?? [],
    ...(origin ? { origin } : {}),
    publishedAt: hit.publishedAt,
  };
}

/**
 * Decode the record's `jinn.trace-envelope.v0` artifact into the plugin's
 * content-bearing `CorpusRecord`. Verifies the artifact bytes against the
 * record's own sha256 before parsing — a mismatch refuses to serve
 * unverified content (mirrors Python `_extract_trace`). Returns `null` when
 * the record carries no trace-envelope artifact (e.g. a skill-only record;
 * pickup selection never fetches these, but the port stays honest for any
 * other caller).
 */
function decodeRecord(record: WireCorpusRecord): CorpusRecord | null {
  const artifact = record.artifacts.find((a) => a.artifactType === TRACE_ENVELOPE_ARTIFACT_TYPE);
  if (!artifact) return null;

  const actualSha256 = createHash('sha256').update(artifact.content).digest('hex');
  if (actualSha256 !== artifact.sha256) {
    throw new Error(
      `sha256 mismatch decoding ${record.ref} — expected ${artifact.sha256.slice(0, 12)}…, `
      + `got ${actualSha256.slice(0, 12)}… — refusing to serve unverified content`,
    );
  }

  const envelope = parseTraceEnvelopeV0(JSON.parse(artifact.content.toString('utf-8')));
  // Packet attribution is display-only, so safeAddress remains an acceptable
  // fallback here after trustworthy agentId; it is never used for hit dedup.
  const origin = record.provenance.operator.agentId || record.provenance.operator.safeAddress || record.ref;

  return {
    ref: record.ref,
    task: { summary: envelope.task.summary },
    outcome: { status: envelope.outcome.status, verifiabilityTier: envelope.outcome.verifiabilityTier },
    ...(envelope.outcome.summary ? { synthesis: envelope.outcome.summary } : {}),
    steps: envelope.steps.map((step) => ({ name: step.name, attributes: step.attributes })),
    tags: envelope.task.distributionTags,
    provenance: envelope.provenance,
    origin,
    capturedAt: envelope.session.capturedAt,
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

    async get(ref: string): Promise<PortResult<CorpusRecord | null>> {
      let record: WireCorpusRecord;
      try {
        record = await layer.corpus.get(ref);
      } catch {
        // `corpus.get` throws on a missing manifest, and the contract requires
        // `ok(null)` for that unknown-ref path (Stage 1). A genuine transport
        // error is currently indistinguishable from not-found via the throw, so
        // it also collapses to `ok(null)` here; distinguishing the two is a
        // follow-up on `consume.ts`'s `corpus.get` surface, not this shim.
        return ok(null);
      }
      try {
        return ok(decodeRecord(record));
      } catch (e) {
        return degraded(`corpus record ${ref} failed to decode: ${String(e)}`, null);
      }
    },
  };
}
