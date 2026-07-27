// SPDX-License-Identifier: MIT
import type { ResultEvaluationEvidence } from "@jinn-network/evidence-protocol";
import type {
  DeclaredEntityOccurrence,
  ResultEvaluationProjection,
} from "../catalog/index.js";
import type { EvidenceRecordReference } from "@jinn-network/evidence-repository";

import { EvidenceIndexerError } from "./errors.js";
import { compareCodeUnits } from "./graph.js";
import { projectResourceDescriptor } from "./project-record.js";

function entityOccurrences(
  evidence: ResultEvaluationEvidence,
): readonly DeclaredEntityOccurrence[] {
  const entities = new Map<string, DeclaredEntityOccurrence>();
  entities.set(evidence.statement.predicate.evaluator.id, {
    entityId: evidence.statement.predicate.evaluator.id,
    types: ["Agent"],
  });
  for (const descriptor of evidence.statement.subject) {
    if (descriptor.uri !== undefined) {
      entities.set(descriptor.uri, { entityId: descriptor.uri, types: [] });
    }
  }
  return [...entities.values()].sort((left, right) =>
    compareCodeUnits(left.entityId, right.entityId),
  );
}

export function projectResultEvaluation(
  reference: EvidenceRecordReference & { readonly family: "result-evaluation" },
  byteSize: number,
  evidence: ResultEvaluationEvidence,
): ResultEvaluationProjection {
  const byName = new Map(
    evidence.statement.subject.map((descriptor) => [descriptor.name, descriptor]),
  );
  const task = byName.get(evidence.statement.predicate.taskSubject);
  const results = evidence.statement.predicate.resultSubjects.map((name) =>
    byName.get(name),
  );
  if (task === undefined || results.some((result) => result === undefined)) {
    throw new EvidenceIndexerError(
      "VALIDATED_RECORD_INCONSISTENT",
      "Validated evaluation subjects are missing a required binding.",
    );
  }

  return structuredClone({
    family: "result-evaluation",
    reference,
    byteSize,
    declaredEntities: entityOccurrences(evidence),
    declaredRelationships: [],
    taskSubject: projectResourceDescriptor(task),
    resultSubjects: results.map((result) =>
      projectResourceDescriptor(result!),
    ) as [
      ReturnType<typeof projectResourceDescriptor>,
      ...ReturnType<typeof projectResourceDescriptor>[],
    ],
    evaluatorId: evidence.statement.predicate.evaluator.id,
    verdict: evidence.statement.predicate.verdict,
    evaluatedAt: evidence.statement.predicate.evaluatedAt,
    supersedes: (evidence.statement.predicate.supersedes ?? []).map(
      projectResourceDescriptor,
    ),
    disputes: (evidence.statement.predicate.disputes ?? []).map(
      projectResourceDescriptor,
    ),
  });
}
