import type { PortResult } from '../outcome.js';
import type { KnowledgeHit } from '../schemas/knowledge-hit.js';

/**
 * One decoded trace step — a light structural echo of the frozen
 * `jinn.trace-envelope.v0` step shape (`spanId`/timing/redaction bookkeeping
 * dropped; array order is the step order). `attributes` follows the existing
 * capture convention (`tool.args`/`tool.result`/`tool.exitCode`; see
 * `projectKnowledgePacket`'s excerpt selection in `schemas/knowledge-packet.ts`).
 */
export interface CorpusRecordStep {
  name: string;
  attributes: Record<string, unknown>;
}

/**
 * A content-bearing corpus record — the `KnowledgeHit` metadata plus decoded
 * evidence content (rescope design §3.1/§3.2): everything
 * `projectKnowledgePacket` needs to build a `KnowledgePacket` without any
 * further I/O. Replaces the pre-rescope metadata-only `get()` return.
 */
export interface CorpusRecord {
  ref: string;
  task: {
    summary: string;
    repositorySlug?: string;
  };
  outcome: {
    status: 'completed' | 'failed' | 'abandoned';
    verifiabilityTier: 'user-accepted' | 'tests-passed' | 'evaluator-verified';
  };
  /** The record's own concise how-it-was-solved text, authored at capture/seed
   *  time — never generated at retrieval time. */
  synthesis?: string;
  steps: CorpusRecordStep[];
  tags: string[];
  provenance: 'imported' | 'contributed';
  /** Display attribution for the rendered packet. The adapter may fall back
   *  to safeAddress here because cross-record dedup already happened on the
   *  search hit's trustworthy `origin`. */
  origin: string;
  capturedAt: string;
  /**
   * True when the adapter's decode determined the record's payload is a
   * skill package — a step carrying a string `skill.md` attribute (legacy
   * pre-#1394 seed shape) or the record backed by a `jinn.skill.v1` artifact
   * (first-class shape) — regardless of the search hit's wire `kind`/
   * `payloadKind` (mono #1782: a legacy skill-shaped record classifies as
   * `kind: 'trace'` on the wire and slips the selection-time filter).
   * Adapter-computed fact; the core (`plugin.ts` `firstTurnPickup`) enforces
   * exclusion — keeps the core the policy owner, the adapter the fact
   * provider. Undefined when undetermined, including when the adapter's own
   * detection errors — the guard fails open, exactly like an ordinary trace
   * record.
   */
  isSkillPayload?: boolean;
  /** Computed in decodeRecord from the envelope's own distributionTags (issue
   *  #1824) — content is the truth, hit metadata is only a hint. Post-fetch
   *  guard in firstTurnPickup drops a record whose content lacks the mark. */
  retrievalVisible?: boolean;
}

export interface CorpusPort {
  search(query: string): Promise<PortResult<KnowledgeHit[]>>;
  get(ref: string): Promise<PortResult<CorpusRecord | null>>;
}
