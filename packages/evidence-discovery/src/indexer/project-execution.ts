// SPDX-License-Identifier: MIT
import {
  ABANDONED_ACTION_STATUS,
  type ExecutionEvidenceDocument,
} from "@jinn-network/evidence-protocol";
import type {
  EvidenceRecordReference,
  ExecutionEvidenceProjection,
} from "../catalog/index.js";

import { EvidenceIndexerError } from "./errors.js";
import {
  artifactProjection,
  compareCodeUnits,
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

function requiredTimestamp(
  entity: ExecutionEvidenceDocument["@graph"][number],
  property: string,
): string {
  const value = requiredString(entity, property);
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/u
      .exec(value);
  if (match === null) inconsistentGraph();
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = Number(match[7] ?? 0);
  const offsetMinute = Number(match[8] ?? 0);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [
    31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
  ];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > monthDays[month - 1]! ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59 ||
    !Number.isFinite(Date.parse(value))
  ) {
    inconsistentGraph();
  }
  return value;
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
    .sort((left, right) => compareCodeUnits(left.entityId, right.entityId));

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
    startedAt: requiredTimestamp(execution, "startTime"),
    endedAt: requiredTimestamp(execution, "endTime"),
    publishedAt: requiredTimestamp(root, "datePublished"),
  };
}
