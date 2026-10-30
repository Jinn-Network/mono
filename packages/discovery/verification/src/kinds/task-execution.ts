// SPDX-License-Identifier: Apache-2.0

import { RECORD_KINDS } from "@jinn-network/record-discovery-protocol";
import {
  DELIVERY_MEDIA_TYPE,
  SUBMISSION_MEDIA_TYPE,
  TASK_EXECUTION_PROTOCOL_URI,
  TASK_MEDIA_TYPE,
  validateDelivery,
  validateObservation,
  validateSubmission,
  validateTask,
} from "@jinn-network/task-execution-protocol";
import type { ValidationResult } from "@jinn-network/task-execution-protocol";

import { documentField, isRecordObject } from "../record-view.js";
import type { RecordView } from "../record-view.js";
import type { Finding } from "../results.js";
import type { RecordKind, RecordReference } from "./kind.js";
import { descriptorListReferences, descriptorReference, digestReference } from "./references.js";

/**
 * Task Execution Protocol: §6.1 seals Task, Submission and Delivery, §21.2 signs them only where a
 * profile requires it, and §10.1 leaves observations unsigned and unsealed in core.
 *
 * All three sealed kinds carry the same `protocol`, so the kind inside the family is told by the
 * required field only that kind has, tested for presence: a Task missing `outputs` must still read
 * as a Task and fail its schema, not fall out as unknown.
 */

const UNSIGNED_IN_CORE = "Task Execution Protocol §21.2: core records are unsigned; a DSSE envelope is required only where a profile requires it.";

/** Observation CloudEvents have no type URL of their own; their schema's served URL names them. */
export const OBSERVATION_KIND = "https://spec.jinn.network/schemas/observation.schema.json";

const OBSERVATION_TYPE_PREFIX = "network.jinn.task-execution.";

function findings(result: ValidationResult): readonly Finding[] {
  return result.errors.map(({ path, message }) => ({ code: "invalid-document", path, detail: message }));
}

function hasField(view: RecordView, name: string): boolean {
  return isRecordObject(view.document) && Object.hasOwn(view.document, name);
}

function isFamilyDocument(view: RecordView): boolean {
  return view.signatures === undefined && documentField(view, "protocol") === TASK_EXECUTION_PROTOCOL_URI;
}

function taskReferences({ document }: RecordView): readonly RecordReference[] {
  const task = document as Record<string, unknown>;
  const outputs = Array.isArray(task["outputs"]) ? task["outputs"] as readonly Record<string, unknown>[] : [];
  return [
    ...descriptorReference(task["profile"], "profileDigest", "/profile", false),
    ...descriptorReference(task["evaluation"], "evaluationDigest", "/evaluation", false),
    ...descriptorReference(task["supersedes"], "supersedesDigest", "/supersedes", false),
    // §7.5: an input may be confidential, and Tasks travel to parties who cannot read it.
    ...descriptorListReferences(task["inputs"], "inputDigests", "/inputs", true),
    ...outputs.flatMap((slot, index) =>
      descriptorReference(slot["schema"], "outputSlotSchemaDigests", `/outputs/${index}/schema`, true)),
  ];
}

function submissionReferences({ document }: RecordView): readonly RecordReference[] {
  return descriptorReference((document as Record<string, unknown>)["task"], "taskDigest", "/task", false);
}

function deliveryReferences({ document }: RecordView): readonly RecordReference[] {
  const delivery = document as Record<string, unknown>;
  const evidence = Array.isArray(delivery["evidenceRecords"])
    ? delivery["evidenceRecords"] as readonly Record<string, unknown>[]
    : [];
  return [
    ...digestReference(delivery["task"], "taskDigest", "/task", false),
    ...descriptorListReferences(delivery["outputs"], "resultDigests", "/outputs", true),
    ...evidence.flatMap((record, index) =>
      digestReference(record["digest"], "evidenceDigests", `/evidenceRecords/${index}/digest`, false)),
    ...digestReference(delivery["supersedes"], "supersedesDigest", "/supersedes", false),
  ];
}

function observationReferences({ document }: RecordView): readonly RecordReference[] {
  const observation = document as Record<string, unknown>;
  const data = isRecordObject(observation["data"]) ? observation["data"] : {};
  return [
    ...digestReference(observation["taskdigest"], "taskdigest", "/taskdigest", false),
    ...digestReference(
      observation["type"] === `${OBSERVATION_TYPE_PREFIX}delivery-recorded.v1` ? data["digest"] : undefined,
      "delivery",
      "/data/digest",
      false,
    ),
    // §9.3: the dispatch context is an input artifact conveyed to the executor.
    ...descriptorReference(data["dispatchContext"], "dispatchContext", "/data/dispatchContext", true),
    ...digestReference(
      isRecordObject(data["evidenceRecord"]) ? data["evidenceRecord"]["digest"] : undefined,
      "evidenceRecord",
      "/data/evidenceRecord/digest",
      false,
    ),
  ];
}

export const TASK_EXECUTION_KINDS: Readonly<Record<string, RecordKind>> = {
  [RECORD_KINDS.task]: {
    family: "task-execution",
    identify: (view) => view.payloadType === TASK_MEDIA_TYPE
      || (isFamilyDocument(view) && !hasField(view, "submission") && !hasField(view, "attempt")),
    validate: ({ document }) => findings(validateTask(document)),
    unsignedBecause: UNSIGNED_IN_CORE,
    references: taskReferences,
  },
  [RECORD_KINDS.submission]: {
    family: "task-execution",
    identify: (view) => view.payloadType === SUBMISSION_MEDIA_TYPE
      || (isFamilyDocument(view) && hasField(view, "submission")),
    validate: ({ document }) => findings(validateSubmission(document)),
    unsignedBecause: UNSIGNED_IN_CORE,
    references: submissionReferences,
    // Trust §7.5b. A Submission states no time of its own, so this needs the caller's `atTime`.
    attribution: (view) => {
      const requester = documentField(view, "requester");
      return typeof requester === "string"
        ? { agent: requester, scope: "authorizations", allowSignsForAuthorization: true }
        : undefined;
    },
  },
  [RECORD_KINDS.delivery]: {
    family: "task-execution",
    identify: (view) => view.payloadType === DELIVERY_MEDIA_TYPE
      || (isFamilyDocument(view) && hasField(view, "attempt") && !hasField(view, "submission")),
    validate: ({ document }) => findings(validateDelivery(document)),
    unsignedBecause: UNSIGNED_IN_CORE,
    references: deliveryReferences,
  },
  [OBSERVATION_KIND]: {
    family: "task-execution",
    identify: (view) => {
      const type = documentField(view, "type");
      return typeof type === "string"
        && type.startsWith(OBSERVATION_TYPE_PREFIX)
        && documentField(view, "specversion") !== undefined;
    },
    validate: ({ document }) => findings(validateObservation(document)),
    encodingExemption: "Task Execution Protocol §6.1 seals Task, Submission and Delivery; an observation is a CloudEvent, and §6.3 binds its exact bytes only where it is referenced as bytes.",
    unsignedBecause: "Task Execution Protocol §10.1: observations are unsigned in core.",
    references: observationReferences,
  },
};
