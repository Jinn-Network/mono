// SPDX-License-Identifier: MIT

import { submissionExtensionBlock } from "@jinn-network/benchmarking-records";
import type { TaskExecutionBackend } from "@jinn-network/task-execution-backend";
import { deriveEvaluationTask } from "@jinn-network/task-execution-profiles";
import {
  DeliveryRecordSchema,
  TaskSpecificationSchema,
  documentDigest,
  sealDelivery,
  sealSubmission,
  sealTask,
  type DeliveryRecord,
} from "@jinn-network/task-execution-protocol";
import { prefixedDigest } from "@jinn-network/policy-identity";
import type { LiveHostJournalTransaction } from "./journal.js";
import { persistPreparedSubmission, type PreparedSubmissionExpectation } from "./prepared-submission.js";
import { submitPreparedDispatch, type AcceptedPreparedDispatch } from "./dispatch.js";
import { HostStateError } from "./state.js";

const encoder = new TextEncoder();
const DOMAIN = "network.jinn.policy-optimization.evaluation-dispatch/1.0\0";

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function deterministicUuid(value: string): `urn:uuid:${string}` {
  const hex = prefixedDigest(encoder.encode(`${DOMAIN}${value}`)).slice("sha256:".length);
  return `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export interface DerivedEvaluationDispatch {
  readonly taskBytes: Uint8Array;
  readonly taskDigest: string;
  readonly submissionBytes: Uint8Array;
  readonly submissionDigest: string;
  readonly expectation: PreparedSubmissionExpectation;
  readonly solverDeliveryDigest: string;
}

/** Deterministically derives the evaluator Task and Submission from exact solver evidence. */
export function deriveEvaluationDispatch(input: {
  readonly campaign: string;
  readonly run: string;
  readonly cellKey: string;
  readonly armId: string;
  readonly dispatch: number;
  readonly requester: string;
  readonly deadline: string;
  readonly requirements: Readonly<Record<string, unknown>>;
  readonly subjectTask: { readonly bytes: Uint8Array; readonly name?: string };
  readonly solverDelivery: { readonly bytes: Uint8Array; readonly record: DeliveryRecord };
  readonly evaluationSpecDigest: `sha256:${string}`;
}): DerivedEvaluationDispatch {
  let subjectTaskValue: unknown;
  try { subjectTaskValue = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.subjectTask.bytes)); }
  catch { throw new HostStateError("state-io", "subject Task is not exact UTF-8 JSON"); }
  const subjectTask = TaskSpecificationSchema.safeParse(subjectTaskValue);
  if (!subjectTask.success || !sameBytes(sealTask(subjectTask.data), input.subjectTask.bytes)) {
    throw new HostStateError("state-io", "subject Task is not an exact canonical sealed document");
  }
  const solverDelivery = DeliveryRecordSchema.safeParse(input.solverDelivery.record);
  if (!solverDelivery.success || !sameBytes(sealDelivery(solverDelivery.data), input.solverDelivery.bytes)) {
    throw new HostStateError("state-io", "solver Delivery record and exact bytes diverge");
  }
  const subjectTaskDigest = documentDigest(input.subjectTask.bytes);
  const solverDeliveryDigest = documentDigest(input.solverDelivery.bytes);
  if (solverDelivery.data.task !== subjectTaskDigest) {
    throw new HostStateError("state-io", "solver Delivery does not bind the exact subject Task");
  }
  const names = new Set<string>();
  const subjectResults = solverDelivery.data.outputs.map((output) => {
    const sha256 = output.digest?.sha256;
    if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(sha256)) {
      throw new HostStateError("state-io", "solver Delivery output lacks an exact sha256 digest");
    }
    // Evaluation subject verification joins supplied Result material to Delivery outputs by the
    // exact output name. Renaming `patch` to `result.patch` makes otherwise valid subject bytes
    // unverifiable, so the derived evaluation Task preserves the Delivery vocabulary verbatim.
    const name = output.name;
    if (names.has(name)) throw new HostStateError("state-io", "solver Delivery output names are ambiguous");
    names.add(name);
    return { name, digest: `sha256:${sha256}` as `sha256:${string}` };
  });
  if (subjectResults.length === 0) throw new HostStateError("state-io", "solver Delivery has no evaluable Result");
  const evaluationTask = deriveEvaluationTask({
    subjectTask: { name: input.subjectTask.name ?? "subject-task.json", digest: subjectTaskDigest },
    subjectDelivery: { name: "subject-delivery.json", digest: solverDeliveryDigest },
    subjectResults,
    evaluationSpecDigest: input.evaluationSpecDigest,
  });
  const identity = [
    input.campaign, input.run, input.cellKey, input.armId, String(input.dispatch),
    evaluationTask.digest, solverDeliveryDigest,
  ].join("\0");
  const idempotencyKey = `${DOMAIN}${prefixedDigest(encoder.encode(identity))}`;
  const submission = deterministicUuid(idempotencyKey);
  const nonce = prefixedDigest(encoder.encode(`${DOMAIN}nonce\0${identity}`));
  const submissionBytes = sealSubmission({
    protocol: "https://spec.jinn.network/profiles/task-execution/v1",
    submission,
    task: { digest: { sha256: evaluationTask.digest.slice("sha256:".length) } },
    requester: input.requester,
    idempotencyKey,
    nonce,
    deadline: input.deadline,
    requirements: input.requirements,
    annotations: submissionExtensionBlock(input.run, input.cellKey, input.armId),
  });
  return {
    taskBytes: evaluationTask.bytes,
    taskDigest: evaluationTask.digest,
    submissionBytes,
    submissionDigest: documentDigest(submissionBytes),
    expectation: {
      campaign: input.campaign,
      run: input.run,
      cellKey: input.cellKey,
      armId: input.armId,
      dispatch: input.dispatch,
      dispatchId: `evaluation/${solverDeliveryDigest}`,
      requester: input.requester,
      nonce,
      idempotencyKey,
      requirements: input.requirements,
    },
    solverDeliveryDigest,
  };
}

/** Persists derivation bindings, then dispatches exact bytes through the evaluator role backend. */
export async function dispatchEvaluation(input: {
  readonly stateRoot: string;
  readonly derived: DerivedEvaluationDispatch;
  readonly backend: TaskExecutionBackend;
  readonly transaction: LiveHostJournalTransaction;
  readonly recordedAt: string;
}): Promise<AcceptedPreparedDispatch> {
  const artifacts = persistPreparedSubmission({
    ...input.derived.expectation,
    stateRoot: input.stateRoot,
    taskBytes: input.derived.taskBytes,
    submissionBytes: input.derived.submissionBytes,
  });
  if (!input.transaction.state.preparedBindings.has(artifacts.bindingDigest)) {
    input.transaction.append({
      type: "submission-prepared",
      recordedAt: input.recordedAt,
      payload: {
        runDigest: input.derived.expectation.run,
        cellKey: input.derived.expectation.cellKey,
        armId: input.derived.expectation.armId,
        dispatch: input.derived.expectation.dispatch,
        role: "evaluator",
        bindingDigest: artifacts.bindingDigest,
      },
    });
  }
  if (!input.transaction.state.evaluationPreparedBindings.has(artifacts.bindingDigest)) {
    input.transaction.append({
      type: "evaluation-prepared",
      recordedAt: input.recordedAt,
      payload: {
        runDigest: input.derived.expectation.run,
        cellKey: input.derived.expectation.cellKey,
        armId: input.derived.expectation.armId,
        dispatch: input.derived.expectation.dispatch,
        solverDeliveryDigest: input.derived.solverDeliveryDigest,
        evaluationTaskDigest: input.derived.taskDigest,
        evaluationSubmissionDigest: input.derived.submissionDigest,
        bindingDigest: artifacts.bindingDigest,
      },
    });
  }
  return submitPreparedDispatch({
    ...input.derived.expectation,
    stateRoot: input.stateRoot,
    taskBytes: input.derived.taskBytes,
    submissionBytes: input.derived.submissionBytes,
    role: "evaluator",
    backend: input.backend,
    transaction: input.transaction,
    recordedAt: input.recordedAt,
  });
}
