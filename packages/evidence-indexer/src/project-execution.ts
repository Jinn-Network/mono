// SPDX-License-Identifier: MIT
import {
  ABANDONED_ACTION_STATUS,
  type ExecutionEvidenceDocument,
} from "@jinn-network/evidence-protocol";
import type {
  EvidenceRecordReference,
  ExecutionEvidenceProjection,
} from "@jinn-network/evidence-catalog";

import { EvidenceIndexerError } from "./errors.js";
import {
  artifactProjection,
  createEntityMap,
  hasType,
  projectDeclaredGraph,
  references,
  requiredEntity,
  requiredSingleReference,
} from "./graph.js";
import { CATALOG_RELATIONSHIP_PREDICATES } from "./projection-terms.js";

const COMPLETED_ACTION_STATUS = "https://schema.org/CompletedActionStatus";
const FAILED_ACTION_STATUS = "https://schema.org/FailedActionStatus";
const COMPACT_ABANDONED_ACTION_STATUS = "jinn:AbandonedActionStatus";
const INCONSISTENT_GRAPH_MESSAGE =
  "Validated graph is missing a required primary relationship.";

function inconsistentGraph(): never {
  throw new EvidenceIndexerError(
    "VALIDATED_RECORD_INCONSISTENT",
    INCONSISTENT_GRAPH_MESSAGE,
  );
}

function requiredString(
  entity: ExecutionEvidenceDocument["@graph"][number],
  property: string,
): string {
  const value = entity[property];
  return typeof value === "string" ? value : inconsistentGraph();
}

function executionOutcome(
  execution: ExecutionEvidenceDocument["@graph"][number],
): ExecutionEvidenceProjection["outcome"] {
  const status = requiredSingleReference(
    execution,
    "actionStatus",
    "Execution status",
  );
  switch (status) {
    case COMPLETED_ACTION_STATUS:
      return "completed";
    case FAILED_ACTION_STATUS:
      return "failed";
    case ABANDONED_ACTION_STATUS:
    case COMPACT_ABANDONED_ACTION_STATUS:
      return "abandoned";
    default:
      return inconsistentGraph();
  }
}

export function projectExecutionEvidence(
  reference: EvidenceRecordReference & {
    readonly family: "execution-evidence";
  },
  byteSize: number,
  document: ExecutionEvidenceDocument,
): ExecutionEvidenceProjection {
  const byId = createEntityMap(document);
  const root = requiredEntity(byId, "./", "Root Dataset");
  const executionId = requiredSingleReference(
    root,
    "mentions",
    "primary Execution",
  );
  const execution = requiredEntity(byId, executionId, "primary Execution");

  const taskCandidates = references(execution, "object")
    .map((id) => requiredEntity(byId, id, "Execution object"))
    .filter(
      (entity) =>
        hasType(entity, "File") &&
        hasType(entity, "CreativeWork") &&
        hasType(entity, "prov:Plan"),
    );
  if (taskCandidates.length !== 1) inconsistentGraph();

  const executorId = requiredSingleReference(
    execution,
    "agent",
    "Executor Agent",
  );
  requiredEntity(byId, executorId, "Executor Agent");

  const runtimeId = requiredSingleReference(
    execution,
    "instrument",
    "Runtime Specification",
  );
  const runtime = requiredEntity(byId, runtimeId, "Runtime Specification");

  const results = references(execution, "result")
    .map((id) => requiredEntity(byId, id, "Result"))
    .map(artifactProjection)
    .sort((left, right) => left.entityId.localeCompare(right.entityId));

  const nativeTraceId = requiredSingleReference(
    execution,
    "subjectOf",
    "native trace",
  );
  const nativeTrace = requiredEntity(byId, nativeTraceId, "native trace");

  const declared = projectDeclaredGraph(
    document,
    CATALOG_RELATIONSHIP_PREDICATES,
    byId,
  );

  return {
    reference: { ...reference },
    byteSize,
    ...declared,
    family: "execution-evidence",
    executionId,
    task: artifactProjection(taskCandidates[0]!),
    executorId,
    runtime: artifactProjection(runtime),
    results,
    nativeTrace: artifactProjection(nativeTrace),
    outcome: executionOutcome(execution),
    startedAt: requiredString(execution, "startTime"),
    endedAt: requiredString(execution, "endTime"),
    publishedAt: requiredString(root, "datePublished"),
  };
}
