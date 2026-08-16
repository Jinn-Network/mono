import { validateAndProjectEvidenceRecord } from "@jinn-network/evidence-discovery/indexer";
import { recordDigest, RECORD_KINDS } from "@jinn-network/record-discovery-protocol";
import type { FactsRecompute, RecordFactRecompute } from "@jinn-network/record-discovery-protocol";

// Record-fact recompute (design §5.4, §10.4 step 2, program §7.13): each
// function recomputes its kind's record facts from the record's own sealed
// BYTES via `validateAndProjectEvidenceRecord` (never from a supplied
// projection -- a lying source cannot spoof facts-consistency by publishing
// a matching projection alongside forged bytes). `CatalogRecordProjection`
// is consulted only as the field-shape reference (imported, not
// re-declared); it is never accepted as recompute input. None of the three
// evidence kinds are reference-bearing to a *different* record's bytes, so
// `refs` (the second recompute parameter) is unused here -- every field
// this leaf projects comes from the record's own statement.
//
// A non-conforming record (malformed bytes, or any unexpected validation
// failure) recomputes to no facts at all (`{}`), which `factsConsistency`
// (protocol) turns into `indeterminate` for every announced field -- never
// silently `consistent` (plan Task 13 Step 2).

function noFacts(): Record<string, never> {
  return {};
}

export const executionEvidenceRecompute: RecordFactRecompute = async (bytes) => {
  try {
    const digest = recordDigest(bytes);
    const result = validateAndProjectEvidenceRecord({ family: "execution-evidence", digest }, bytes);
    if (!result.conforms || result.projection.family !== "execution-evidence") return noFacts();
    const { projection } = result;
    return {
      executionId: projection.executionId,
      executorId: projection.executorId,
      taskDigest: projection.task.digest,
      outcome: projection.outcome,
      startedAt: projection.startedAt,
      endedAt: projection.endedAt,
      publishedAt: projection.publishedAt,
    };
  } catch {
    return noFacts();
  }
};

export const resultEvaluationRecompute: RecordFactRecompute = async (bytes) => {
  try {
    const digest = recordDigest(bytes);
    const result = validateAndProjectEvidenceRecord({ family: "result-evaluation", digest }, bytes);
    if (!result.conforms || result.projection.family !== "result-evaluation") return noFacts();
    const { projection } = result;
    return {
      evaluatorId: projection.evaluatorId,
      verdict: projection.verdict,
      evaluatedAt: projection.evaluatedAt,
      taskDigest: projection.taskSubject.digest,
      resultDigest: projection.resultSubjects[0].digest,
    };
  } catch {
    return noFacts();
  }
};

export const executionEvidenceRecomputeV2: RecordFactRecompute = async (bytes) => {
  try {
    const digest = recordDigest(bytes);
    const result = validateAndProjectEvidenceRecord({ family: "execution-evidence", digest }, bytes);
    if (!result.conforms || result.projection.family !== "execution-evidence") return noFacts();
    const { projection } = result;
    return {
      executionId: projection.executionId,
      executorId: projection.executorId,
      taskDigest: projection.task.digest,
      runtimeDigest: projection.runtime.digest,
      resultDigests: projection.results.map(({ digest }) => digest),
      outcome: projection.outcome,
      startedAt: projection.startedAt,
      endedAt: projection.endedAt,
      publishedAt: projection.publishedAt,
    };
  } catch {
    return noFacts();
  }
};

export const resultEvaluationRecomputeV2: RecordFactRecompute = async (bytes) => {
  try {
    const digest = recordDigest(bytes);
    const result = validateAndProjectEvidenceRecord({ family: "result-evaluation", digest }, bytes);
    if (!result.conforms || result.projection.family !== "result-evaluation") return noFacts();
    const { projection } = result;
    return {
      evaluatorId: projection.evaluatorId,
      verdict: projection.verdict,
      evaluatedAt: projection.evaluatedAt,
      taskDigest: projection.taskSubject.digest,
      resultDigests: projection.resultSubjects.map(({ digest }) => digest),
    };
  } catch {
    return noFacts();
  }
};

export const executionVerificationRecompute: RecordFactRecompute = async (bytes) => {
  try {
    const digest = recordDigest(bytes);
    const result = validateAndProjectEvidenceRecord({ family: "execution-verification", digest }, bytes);
    if (!result.conforms || result.projection.family !== "execution-verification") return noFacts();
    const { projection } = result;
    return {
      verifierId: projection.verifierId,
      verdict: projection.verdict,
      verifiedAt: projection.verifiedAt,
      executionId: projection.executionId,
      subjectDigest: projection.subjectRecord.digest,
    };
  } catch {
    return noFacts();
  }
};

/** The leaf's `FactsRecompute` registry entry (program §7.13): the host
 * assembles the tree-wide registry by merging each leaf's export. */
export const EVIDENCE_FACTS_RECOMPUTE: FactsRecompute = {
  get(kind: string): RecordFactRecompute | undefined {
    switch (kind) {
      case RECORD_KINDS.executionEvidence:
        return executionEvidenceRecompute;
      case RECORD_KINDS.resultEvaluation:
        return resultEvaluationRecompute;
      case RECORD_KINDS.executionVerification:
        return executionVerificationRecompute;
      default:
        return undefined;
    }
  },
};

/** Explicit registry for the coexisting Evidence public-facts v2 profiles. */
export const EVIDENCE_FACTS_RECOMPUTE_V2: FactsRecompute = {
  get(kind: string): RecordFactRecompute | undefined {
    switch (kind) {
      case RECORD_KINDS.executionEvidence:
        return executionEvidenceRecomputeV2;
      case RECORD_KINDS.resultEvaluation:
        return resultEvaluationRecomputeV2;
      case RECORD_KINDS.executionVerification:
        return executionVerificationRecompute;
      default:
        return undefined;
    }
  },
};
