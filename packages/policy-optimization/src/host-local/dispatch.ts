// SPDX-License-Identifier: MIT

import type { TaskExecutionBackend } from "@jinn-network/task-execution-backend";
import {
  DeliveryRecordSchema,
  documentDigest,
  sealDelivery,
  type DeliveryRecord,
} from "@jinn-network/task-execution-protocol";
import type { LiveHostJournalTransaction } from "./journal.js";
import {
  persistPreparedSubmission,
  recoverPreparedSubmission,
  type PreparedSubmissionExpectation,
} from "./prepared-submission.js";
import { HostStateError } from "./state.js";

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function exactDelivery(bytes: Uint8Array): DeliveryRecord {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new HostStateError("state-io", "Delivery is not exact UTF-8 JSON"); }
  const parsed = DeliveryRecordSchema.safeParse(value);
  if (!parsed.success || !sameBytes(sealDelivery(parsed.data), bytes)) {
    throw new HostStateError("state-io", "Delivery is not an exact canonical sealed record");
  }
  return parsed.data;
}

function assertObservedBinding(input: {
  readonly taskDigest: string;
  readonly submission: string;
  readonly snapshot: Awaited<ReturnType<TaskExecutionBackend["observe"]>>;
}): void {
  const descriptor = input.snapshot.descriptor;
  if (descriptor.task !== input.taskDigest || descriptor.submission !== input.submission
    || descriptor.derived.contradictory) {
    throw new HostStateError("state-io", "backend observation contradicts the exact prepared dispatch");
  }
}

export interface AcceptedPreparedDispatch {
  readonly attempt: string;
  readonly submission: string;
  readonly submissionDigest: string;
  readonly bindingDigest: string;
  readonly recovered: boolean;
}

/**
 * The only live submit path: exact bytes are persisted first, pinning admission must be positive,
 * and acknowledgement plus materialized Attempt bindings are checked before journalling success.
 */
export async function submitPreparedDispatch(input: PreparedSubmissionExpectation & {
  readonly stateRoot: string;
  readonly taskBytes: Uint8Array;
  readonly submissionBytes: Uint8Array;
  readonly role: "solver" | "evaluator";
  readonly backend: TaskExecutionBackend;
  readonly transaction: LiveHostJournalTransaction;
  readonly recordedAt: string;
}): Promise<AcceptedPreparedDispatch> {
  if (input.transaction.state.phase !== "ACTIVE") {
    throw new HostStateError("state-io", "new dispatch is forbidden while cancelling or closed");
  }
  const artifacts = persistPreparedSubmission(input);
  const prior = input.transaction.state.acceptedBindings.get(artifacts.bindingDigest);
  if (prior !== undefined) {
    if (prior.role !== input.role) throw new HostStateError("state-io", "prepared dispatch role changed on recovery");
    const reconciled = await input.backend.recover(prior.attempt as never);
    if (reconciled.classification !== "matching") {
      throw new HostStateError("state-io", "accepted dispatch recovery was absent or contradictory");
    }
    const snapshot = await input.backend.observe(prior.attempt as never);
    assertObservedBinding({
      taskDigest: artifacts.binding.taskDigest,
      submission: prior.submission,
      snapshot,
    });
    return {
      attempt: prior.attempt,
      submission: prior.submission,
      submissionDigest: artifacts.binding.submissionDigest,
      bindingDigest: artifacts.bindingDigest,
      recovered: true,
    };
  }

  if (!input.transaction.state.preparedBindings.has(artifacts.bindingDigest)) {
    input.transaction.append({
      type: "submission-prepared",
      recordedAt: input.recordedAt,
      payload: {
        runDigest: input.run,
        cellKey: input.cellKey,
        armId: input.armId,
        dispatch: input.dispatch,
        role: input.role,
        bindingDigest: artifacts.bindingDigest,
      },
    });
  } else {
    // Re-read rather than trusting the just-computed caller bytes when resuming a durable prepare.
    recoverPreparedSubmission(input);
  }

  if (input.backend.preflight === undefined) {
    throw new HostStateError("state-io", "live backend cannot prove positive pinning admission");
  }
  const profile = artifacts.task.profile.uri;
  const admission = await input.backend.preflight({
    ...(profile === undefined ? {} : { taskProfile: profile }),
    requirements: input.requirements,
  });
  if (!admission.ready) {
    throw new HostStateError("state-io", "live backend refused positive pinning admission");
  }
  const ack = await input.backend.submit(artifacts.taskBytes, artifacts.submissionBytes);
  if (!ack.accepted
    || ack.digest !== artifacts.binding.submissionDigest
    || ack.submission !== artifacts.submission.submission) {
    throw new HostStateError("state-io", "backend did not positively accept the exact prepared Submission");
  }
  const snapshot = await input.backend.observe(ack.submission);
  assertObservedBinding({ taskDigest: artifacts.binding.taskDigest, submission: ack.submission, snapshot });
  const attempt = snapshot.descriptor.attempt;
  input.transaction.append({
    type: "submission-accepted",
    recordedAt: input.recordedAt,
    payload: {
      runDigest: input.run,
      cellKey: input.cellKey,
      armId: input.armId,
      dispatch: input.dispatch,
      role: input.role,
      bindingDigest: artifacts.bindingDigest,
      submission: ack.submission,
      attempt,
    },
  });
  return {
    attempt,
    submission: ack.submission,
    submissionDigest: ack.digest,
    bindingDigest: artifacts.bindingDigest,
    recovered: false,
  };
}

export interface RetrievedDelivery {
  readonly record: DeliveryRecord;
  readonly bytes: Uint8Array;
  readonly digest: string;
}

/** Retrieves and verifies every exact Delivery, then returns the unique unsuperseded head. */
export async function retrieveExactDeliveries(input: {
  readonly backend: TaskExecutionBackend;
  readonly attempt: string;
  readonly taskDigest: string;
  readonly submission: string;
}): Promise<{ readonly deliveries: readonly RetrievedDelivery[]; readonly head: RetrievedDelivery }> {
  const snapshot = await input.backend.observe(input.attempt as never);
  assertObservedBinding({ taskDigest: input.taskDigest, submission: input.submission, snapshot });
  if (!snapshot.descriptor.derived.terminal || snapshot.descriptor.derived.state !== "delivered") {
    throw new HostStateError("state-io", "solver Attempt is not terminal-delivered");
  }
  const refs = await input.backend.deliveries(input.attempt as never);
  if (refs.length === 0) throw new HostStateError("state-io", "terminal-delivered Attempt has no Delivery");
  const deliveries: RetrievedDelivery[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    if (ref.attempt !== input.attempt || seen.has(ref.digest)) {
      throw new HostStateError("state-io", "Delivery reference attempt or uniqueness binding failed");
    }
    const bytes = await input.backend.fetchDelivery(ref);
    if (documentDigest(bytes) !== ref.digest) throw new HostStateError("state-io", "Delivery digest substitution detected");
    const record = exactDelivery(bytes);
    if (record.attempt !== input.attempt || record.task !== input.taskDigest) {
      throw new HostStateError("state-io", "Delivery does not bind the dispatched Attempt and Task");
    }
    seen.add(ref.digest);
    deliveries.push({ record, bytes, digest: ref.digest });
  }
  const superseded = new Set(deliveries.flatMap((delivery) =>
    delivery.record.supersedes === undefined ? [] : [delivery.record.supersedes]));
  const heads = deliveries.filter((delivery) => !superseded.has(delivery.digest));
  if (heads.length !== 1) throw new HostStateError("state-io", "Delivery supersession graph has no unique head");
  return { deliveries, head: heads[0]! };
}
