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
import {
  degraded,
  EpisodeV1Schema,
  ok,
  hasRetrievalMark,
  RETRIEVAL_VISIBLE_TAG,
} from '@jinn-network/plugin';
import {
  createHarnessLayer,
  type CorpusRecord as WireCorpusRecord,
  type CorpusSearchHit,
  type HarnessLayer,
  type HarnessLayerConfig,
} from '../consume.js';
import { parseTraceEnvelopeV0, type TraceEnvelopeV0, type TraceStep } from '../envelope.js';
import {
  EPISODE_ARTIFACT_TYPE,
  TRACE_ENVELOPE_ARTIFACT_TYPE,
} from '../publish.js';
import { SKILL_ARTIFACT_TYPE } from '../../../../src/types/skill-artifact.js';

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
  const tags = hit.tags ?? [];
  // Named indexed metadata is authoritative when present. The legacy mark is
  // only a fallback for rows indexed before that field existed.
  const retrievalVisible = hit.retrievalVisible ?? hasRetrievalMark(tags);
  return {
    ref: hit.ref,
    kind: hit.kind === 'skill' ? 'skill' : 'trace',
    ...(hit.title ? { title: hit.title } : {}),
    ...(hit.summary ? { snippet: hit.summary } : {}),
    tags: tags.filter((tag) => tag !== RETRIEVAL_VISIBLE_TAG),
    ...(origin ? { origin } : {}),
    publishedAt: hit.publishedAt,
    retrievalVisible,
  };
}

/**
 * The evidence-episode seed lane (`seed-import/episode-execute.ts`) authors a
 * synthesis longer than `outcome.summary`'s 500-char cap allows, so it carries
 * the text on a step attribute (`seed.synthesis`, on the final `seed:synthesis`
 * step) instead. Fall back to it only when the envelope's own `outcome.summary`
 * is absent — a real capture's synthesis, when present, always wins.
 */
type EvidenceStep = Pick<TraceStep, 'name' | 'attributes'>;

function seedStepSynthesis(steps: readonly EvidenceStep[]): string | undefined {
  for (const step of steps) {
    const value = step.attributes['seed.synthesis'];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return undefined;
}

/**
 * True when any step carries a string `skill.md` attribute — the legacy
 * pre-#1394 seed shape (`seed-import/execute.ts` `toCapturedTask`). Checks
 * every step, not only one named `seed:skill-md`: the wire shape this guard
 * exists for already lied about `kind` once, so detection here keys on the
 * attribute itself, not a step-naming convention layered on top of it.
 */
function hasSkillMdAttribute(steps: readonly EvidenceStep[]): boolean {
  return steps.some((step) => {
    const value = step.attributes['skill.md'];
    return typeof value === 'string' && value.length > 0;
  });
}

/**
 * Content-level skill-payload classification (mono #1782): true when the
 * record is a skill package regardless of the search hit's wire `kind` —
 * either a first-class `jinn.skill.v1` artifact (checked by presence only,
 * not parsed/validated here — parsing a malformed skill artifact's body is
 * `extractSkill()`'s job, and must not be able to fail *this* guard), or the
 * legacy seeded shape `hasSkillMdAttribute` recognises.
 */
function detectSkillPayload(record: WireCorpusRecord, steps: readonly EvidenceStep[]): boolean {
  if (record.artifacts.some((a) => a.artifactType === SKILL_ARTIFACT_TYPE)) return true;
  return hasSkillMdAttribute(steps);
}

interface DecodedEvidencePayload {
  task: { summary: string; distributionTags: string[]; repositorySlug?: string };
  retrievalVisible?: boolean;
  outcome: {
    status: 'completed' | 'failed' | 'abandoned';
    verificationStrength: 'user-accepted' | 'tests-passed' | 'evaluator-verified';
    summary?: string;
  };
  steps: EvidenceStep[];
  provenance: 'imported' | 'contributed' | 'derived-from-history';
  capturedAt: string;
}

function decodeEvidencePayload(
  artifactType: string,
  content: Buffer,
): DecodedEvidencePayload {
  const body: unknown = JSON.parse(content.toString('utf-8'));
  if (artifactType === EPISODE_ARTIFACT_TYPE) {
    const declaresRetrievalVisible =
      body !== null
      && typeof body === 'object'
      && Object.prototype.hasOwnProperty.call(body, 'retrievalVisible');
    const episode = EpisodeV1Schema.parse(body);
    return {
      task: episode.task,
      ...(declaresRetrievalVisible
        ? { retrievalVisible: episode.retrievalVisible }
        : {}),
      outcome: episode.outcome,
      steps: episode.trajectory,
      provenance: episode.provenance,
      capturedAt: episode.session.capturedAt,
    };
  }

  const trace = parseTraceEnvelopeV0(body);
  return {
    task: trace.task,
    retrievalVisible: hasRetrievalMark(trace.task.distributionTags),
    outcome: {
      status: trace.outcome.status,
      verificationStrength: trace.outcome.verifiabilityTier,
      ...(trace.outcome.summary ? { summary: trace.outcome.summary } : {}),
    },
    steps: trace.steps,
    provenance: trace.provenance,
    capturedAt: trace.session.capturedAt,
  };
}

/**
 * Decode the record's canonical `jinn.episode.v1` artifact (or frozen
 * `jinn.trace-envelope.v0` read-compat artifact) into the plugin's
 * content-bearing `CorpusRecord`. Verifies the artifact bytes against the
 * record's own sha256 before parsing — a mismatch refuses to serve
 * unverified content (mirrors Python `_extract_trace`). Returns `null` when
 * the record carries no trace-envelope artifact (e.g. a skill-only record;
 * pickup selection never fetches these, but the port stays honest for any
 * other caller).
 */
function decodeRecord(record: WireCorpusRecord): CorpusRecord | null {
  const artifact =
    record.artifacts.find((a) => a.artifactType === EPISODE_ARTIFACT_TYPE)
    ?? record.artifacts.find((a) => a.artifactType === TRACE_ENVELOPE_ARTIFACT_TYPE);
  if (!artifact) return null;

  const actualSha256 = createHash('sha256').update(artifact.content).digest('hex');
  if (actualSha256 !== artifact.sha256) {
    throw new Error(
      `sha256 mismatch decoding ${record.ref} — expected ${artifact.sha256.slice(0, 12)}…, `
      + `got ${actualSha256.slice(0, 12)}… — refusing to serve unverified content`,
    );
  }

  const evidence = decodeEvidencePayload(artifact.artifactType, artifact.content);
  // Packet attribution is display-only, so safeAddress remains an acceptable
  // fallback here after trustworthy agentId; it is never used for hit dedup.
  const origin = record.provenance.operator.agentId || record.provenance.operator.safeAddress || record.ref;
  const synthesis = evidence.outcome.summary ?? seedStepSynthesis(evidence.steps);

  // Fails open (mono #1782): a detection error never blocks the rest of the
  // record's content from being served — it just leaves the fact
  // undetermined, exactly as if this guard did not exist for that record.
  let isSkillPayload = false;
  try {
    isSkillPayload = detectSkillPayload(record, evidence.steps);
  } catch {
    isSkillPayload = false;
  }

  // Content remains the guard: a named canonical boolean is authoritative
  // when the raw body declared it, and only legacy absence falls back to the
  // compatibility mark.
  const retrievalVisible =
    evidence.retrievalVisible ?? hasRetrievalMark(evidence.task.distributionTags);

  return {
    ref: record.ref,
    task: {
      summary: evidence.task.summary,
      ...(evidence.task.repositorySlug
        ? { repositorySlug: evidence.task.repositorySlug }
        : {}),
    },
    outcome: {
      status: evidence.outcome.status,
      verifiabilityTier: evidence.outcome.verificationStrength,
    },
    ...(synthesis ? { synthesis } : {}),
    steps: evidence.steps.map((step) => ({ name: step.name, attributes: step.attributes })),
    // Deliberately un-stripped (unlike the search-hit path): CorpusRecord.tags
    // is provenance-adjacent display data on the fetched packet, never fed to
    // the scoring haystack — hiding the mark here would hide provenance.
    tags: evidence.task.distributionTags,
    retrievalVisible,
    provenance: evidence.provenance,
    origin,
    capturedAt: evidence.capturedAt,
    ...(isSkillPayload ? { isSkillPayload: true } : {}),
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
