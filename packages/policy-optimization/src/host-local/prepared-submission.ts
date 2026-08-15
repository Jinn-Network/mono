// SPDX-License-Identifier: MIT

import {
  canonicalJsonBytes,
  prefixedDigest,
  type JsonValue,
} from "@jinn-network/policy-identity";
import { submissionExtensionBlock } from "@jinn-network/benchmarking-records";
import {
  SubmissionRecordSchema,
  TaskSpecificationSchema,
  documentDigest,
  sealSubmission,
  sealTask,
  type SubmissionRecord,
  type TaskSpecification,
} from "@jinn-network/task-execution-protocol";
import { join } from "node:path";
import { z } from "zod";
import { HostStateError, secureAtomicWrite, secureRead } from "./state.js";

export const PREPARED_SUBMISSION_FORMAT_TOKEN =
  "network.jinn.policy-optimization.prepared-submission/1.0" as const;

const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const NonEmpty = z.string().min(1);
const BindingSchema = z.strictObject({
  formatToken: z.literal(PREPARED_SUBMISSION_FORMAT_TOKEN),
  campaign: Digest,
  run: Digest,
  cellKey: NonEmpty,
  armId: NonEmpty,
  dispatch: z.number().int().positive(),
  dispatchId: NonEmpty,
  requester: NonEmpty,
  nonce: NonEmpty,
  idempotencyKey: NonEmpty,
  taskDigest: Digest,
  submissionDigest: Digest,
  requirementsDigest: Digest,
});

export interface PreparedSubmissionExpectation {
  readonly campaign: string;
  readonly run: string;
  readonly cellKey: string;
  readonly armId: string;
  readonly dispatch: number;
  readonly dispatchId: string;
  readonly requester: string;
  readonly nonce: string;
  readonly idempotencyKey: string;
  readonly requirements: Readonly<Record<string, unknown>>;
}

export type PreparedSubmissionBinding = z.infer<typeof BindingSchema>;

export interface PreparedSubmissionArtifacts {
  readonly taskBytes: Uint8Array;
  readonly submissionBytes: Uint8Array;
  readonly task: TaskSpecification;
  readonly submission: SubmissionRecord;
  readonly binding: PreparedSubmissionBinding;
  readonly bindingBytes: Uint8Array;
  readonly bindingDigest: string;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function exactDocument<T>(
  bytes: Uint8Array,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  seal: (value: unknown) => Uint8Array,
  label: string,
): T {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new HostStateError("state-io", `${label} is not exact UTF-8 JSON`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success || !sameBytes(seal(parsed.data), bytes)) {
    throw new HostStateError("state-io", `${label} is not an exact canonical sealed document`);
  }
  return parsed.data;
}

function canonicalRecord(value: unknown, label: string): Uint8Array {
  try {
    return canonicalJsonBytes(value as JsonValue);
  } catch {
    throw new HostStateError("state-io", `${label} is not canonical I-JSON`);
  }
}

function assertSameCanonical(left: unknown, right: unknown, label: string): void {
  if (!sameBytes(canonicalRecord(left, label), canonicalRecord(right, label))) {
    throw new HostStateError("state-io", `${label} does not match the frozen dispatch`);
  }
}

function expectedBinding(
  expected: PreparedSubmissionExpectation,
  taskBytes: Uint8Array,
  submissionBytes: Uint8Array,
  task: TaskSpecification,
  submission: SubmissionRecord,
): PreparedSubmissionBinding {
  const taskDigest = documentDigest(taskBytes);
  const submissionDigest = documentDigest(submissionBytes);
  if (submission.task.digest?.sha256 !== taskDigest.slice("sha256:".length)) {
    throw new HostStateError("state-io", "Submission does not bind the exact prepared Task");
  }
  if (submission.requester !== expected.requester
    || submission.nonce !== expected.nonce
    || submission.idempotencyKey !== expected.idempotencyKey) {
    throw new HostStateError("state-io", "Submission requester, nonce, or idempotency binding moved");
  }
  assertSameCanonical(submission.requirements ?? {}, expected.requirements, "Submission requirements");
  assertSameCanonical(
    submission.annotations ?? {},
    submissionExtensionBlock(expected.run, expected.cellKey, expected.armId),
    "Submission Run/cell/arm annotations",
  );
  // Force schema evaluation before constructing the binding, including Task extension validation.
  void task;
  return BindingSchema.parse({
    formatToken: PREPARED_SUBMISSION_FORMAT_TOKEN,
    campaign: expected.campaign,
    run: expected.run,
    cellKey: expected.cellKey,
    armId: expected.armId,
    dispatch: expected.dispatch,
    dispatchId: expected.dispatchId,
    requester: expected.requester,
    nonce: expected.nonce,
    idempotencyKey: expected.idempotencyKey,
    taskDigest,
    submissionDigest,
    requirementsDigest: prefixedDigest(canonicalRecord(expected.requirements, "Submission requirements")),
  });
}

function paths(stateRoot: string, binding: Pick<PreparedSubmissionBinding,
  "campaign" | "run" | "cellKey" | "armId" | "dispatch" | "dispatchId">) {
  const campaign = binding.campaign.slice("sha256:".length);
  const identity = {
    campaign: binding.campaign,
    run: binding.run,
    cellKey: binding.cellKey,
    armId: binding.armId,
    dispatch: binding.dispatch,
    dispatchId: binding.dispatchId,
  };
  const dispatch = prefixedDigest(canonicalJsonBytes(identity)).slice("sha256:".length);
  const root = join(stateRoot, "campaigns", campaign, "prepared", dispatch);
  return {
    task: join(root, "task.sealed.json"),
    submission: join(root, "submission.sealed.json"),
    binding: join(root, "binding.canonical.json"),
  };
}

function parseExactBinding(bytes: Uint8Array): PreparedSubmissionBinding {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new HostStateError("state-io", "prepared binding is not UTF-8 JSON"); }
  const parsed = BindingSchema.safeParse(value);
  if (!parsed.success || !sameBytes(canonicalRecord(parsed.data, "prepared binding"), bytes)) {
    throw new HostStateError("state-io", "prepared binding is not exact canonical data");
  }
  return parsed.data;
}

function validateArtifacts(
  expected: PreparedSubmissionExpectation,
  taskBytes: Uint8Array,
  submissionBytes: Uint8Array,
  bindingBytes?: Uint8Array,
): PreparedSubmissionArtifacts {
  const task = exactDocument(taskBytes, TaskSpecificationSchema, sealTask, "prepared Task");
  const submission = exactDocument(
    submissionBytes, SubmissionRecordSchema, sealSubmission, "prepared Submission",
  );
  const binding = expectedBinding(expected, taskBytes, submissionBytes, task, submission);
  const canonicalBinding = canonicalRecord(binding, "prepared binding");
  if (bindingBytes !== undefined) {
    const persisted = parseExactBinding(bindingBytes);
    assertSameCanonical(persisted, binding, "prepared binding");
  }
  return {
    taskBytes,
    submissionBytes,
    task,
    submission,
    binding,
    bindingBytes: canonicalBinding,
    bindingDigest: prefixedDigest(canonicalBinding),
  };
}

/** Persists immutable exact bytes before any backend submit call can occur. */
export function persistPreparedSubmission(input: PreparedSubmissionExpectation & {
  readonly stateRoot: string;
  readonly taskBytes: Uint8Array;
  readonly submissionBytes: Uint8Array;
}): PreparedSubmissionArtifacts {
  const artifacts = validateArtifacts(input, input.taskBytes, input.submissionBytes);
  const artifactPaths = paths(input.stateRoot, artifacts.binding);
  // The manifest is published last; a crash before it exists is an incomplete preparation, not a
  // reusable Submission. Repeating preparation with identical bytes safely completes the set.
  secureAtomicWrite(artifactPaths.task, artifacts.taskBytes, true);
  secureAtomicWrite(artifactPaths.submission, artifacts.submissionBytes, true);
  secureAtomicWrite(artifactPaths.binding, artifacts.bindingBytes, true);
  return artifacts;
}

/** Recovery revalidates every semantic and byte binding before returning reusable bytes. */
export function recoverPreparedSubmission(input: PreparedSubmissionExpectation & {
  readonly stateRoot: string;
}): PreparedSubmissionArtifacts {
  const artifactPaths = paths(input.stateRoot, input);
  const bindingBytes = secureRead(artifactPaths.binding);
  const persisted = parseExactBinding(bindingBytes);
  const taskBytes = secureRead(artifactPaths.task);
  const submissionBytes = secureRead(artifactPaths.submission);
  const artifacts = validateArtifacts(input, taskBytes, submissionBytes, bindingBytes);
  if (persisted.taskDigest !== artifacts.binding.taskDigest
    || persisted.submissionDigest !== artifacts.binding.submissionDigest) {
    throw new HostStateError("state-io", "prepared artifact digest substitution detected");
  }
  return artifacts;
}
