// SPDX-License-Identifier: MIT
import type { ExecutionVerificationEvidence } from "@jinn-network/evidence-protocol";
import type {
  DeclaredEntityOccurrence,
  ExecutionVerificationProjection,
} from "../catalog/index.js";
import type { EvidenceRecordReference } from "@jinn-network/evidence-repository";

import {
  executionRecordDigest,
  projectResourceDescriptor,
} from "./project-record.js";
import { compareCodeUnits } from "./graph.js";

function entityOccurrences(
  evidence: ExecutionVerificationEvidence,
): readonly DeclaredEntityOccurrence[] {
  return [
    {
      entityId: evidence.statement.predicate.executionId,
      types: ["CreateAction"],
    },
    {
      entityId: evidence.statement.predicate.verifier.id,
      types: ["Agent"],
    },
  ].sort((left, right) => compareCodeUnits(left.entityId, right.entityId));
}

export function projectExecutionVerification(
  reference: EvidenceRecordReference & {
    readonly family: "execution-verification";
  },
  byteSize: number,
  evidence: ExecutionVerificationEvidence,
): ExecutionVerificationProjection {
  return structuredClone({
    family: "execution-verification",
    reference,
    byteSize,
    declaredEntities: entityOccurrences(evidence),
    declaredRelationships: [],
    subjectRecord: {
      family: "execution-evidence",
      digest: executionRecordDigest(evidence),
    },
    executionId: evidence.statement.predicate.executionId,
    verifierId: evidence.statement.predicate.verifier.id,
    verdict: evidence.statement.predicate.verdict,
    verifiedAt: evidence.statement.predicate.verifiedAt,
    supersedes: (evidence.statement.predicate.supersedes ?? []).map(
      projectResourceDescriptor,
    ),
    disputes: (evidence.statement.predicate.disputes ?? []).map(
      projectResourceDescriptor,
    ),
  });
}
