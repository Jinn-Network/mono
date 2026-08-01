import type { EvidenceRepositoryWriter } from '@jinn-network/task-execution-evaluation-harness';

export interface EvaluatorSettings {
  readonly maxClaimEvidenceBytes: number;
  readonly evaluatorAgentIri: string;
}

const DEFAULT_MAX_CLAIM_EVIDENCE_BYTES = 4 * 1024 * 1024;
const DEFAULT_EVALUATOR_AGENT_IRI = 'https://agents.example/jinn/operator-evaluator';

/** Minimal Task-14 stand-in until the full evaluator config block lands. */
export function evaluatorSettings(): EvaluatorSettings {
  return {
    maxClaimEvidenceBytes: DEFAULT_MAX_CLAIM_EVIDENCE_BYTES,
    evaluatorAgentIri: DEFAULT_EVALUATOR_AGENT_IRI,
  };
}

/** In-memory no-op evidence writer for module-level deployment wiring and unit tests. */
export function operatorEvidenceWriter(): EvidenceRepositoryWriter {
  const store = new Map<string, Uint8Array>();
  return {
    async putClaimEvidence(evidence) {
      store.set(evidence.name, evidence.bytes);
      return {
        name: evidence.name,
        digest: { sha256: '0'.repeat(64) },
        ...(evidence.mediaType === undefined ? {} : { mediaType: evidence.mediaType }),
      };
    },
  };
}
