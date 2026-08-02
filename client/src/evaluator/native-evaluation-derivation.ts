import { deriveAndSealEvaluationSubmission } from "@jinn-network/marketplace-binding";
import {
  DeliveryRecordSchema,
  SubmissionRecordSchema,
  documentDigest,
} from "@jinn-network/task-execution-protocol";
import type { SubjectMaterial } from "./subject-material.js";

function parseExact<T>(bytes: Uint8Array, parse: (value: unknown) => T, label: string): T {
  try {
    return parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch (cause) {
    throw new Error(`${label} is not an exact protocol record: ${String(cause)}`);
  }
}

function verifyGraph(material: SubjectMaterial): void {
  const artifacts = [
    material.task,
    material.submission,
    material.requesterEnvelope,
    material.admissionReceipt,
    material.delivery,
    material.deliveryEnvelope,
    ...material.evidenceRecords,
    ...material.results,
    material.evaluationSpec,
  ];
  for (const artifact of artifacts) {
    const actual = documentDigest(artifact.bytes);
    if (actual !== artifact.digest) {
      throw new Error(`${artifact.name} digest mismatch: expected ${artifact.digest}, got ${actual}`);
    }
  }
}

function deterministicUuid(id: `sha256:${string}`): string {
  const value = id.slice("sha256:".length, "sha256:".length + 32).split("");
  value[12] = "5";
  value[16] = ((Number.parseInt(value[16]!, 16) & 0x3) | 0x8).toString(16);
  const hex = value.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface NativeDerivedEvaluation {
  readonly taskBytes: Uint8Array;
  readonly taskDigest: `sha256:${string}`;
  readonly submissionBytes: Uint8Array;
  readonly submissionDigest: `sha256:${string}`;
  readonly submissionUri: `urn:uuid:${string}`;
}

/** Pair-fixed protocol derivation; full graph verification precedes the narrower TEP pair seal. */
export function deriveNativeEvaluation(input: {
  readonly evaluationId: `sha256:${string}`;
  readonly evaluatorAgent: string;
  readonly material: SubjectMaterial;
  readonly deadline: string;
}): NativeDerivedEvaluation {
  verifyGraph(input.material);
  const subjectSubmission = parseExact(
    input.material.submission.bytes,
    (value) => SubmissionRecordSchema.parse(value),
    "subject Submission",
  );
  const subjectDelivery = parseExact(
    input.material.delivery.bytes,
    (value) => DeliveryRecordSchema.parse(value),
    "subject Delivery",
  );
  if (subjectDelivery.task !== input.material.task.digest) {
    throw new Error("subject Delivery does not bind the exact subject Task");
  }
  const uuid = deterministicUuid(input.evaluationId);
  const result = deriveAndSealEvaluationSubmission({
    subjectTask: { name: input.material.task.name, digest: input.material.task.digest },
    subjectSubmission,
    subjectDelivery: { name: input.material.delivery.name, digest: input.material.delivery.digest },
    subjectResults: input.material.results.map(({ name, digest }) => ({ name, digest })),
    evaluationSpecDigest: input.material.evaluationSpec.digest,
    submissionFields: {
      submission: `urn:uuid:${uuid}`,
      requester: input.evaluatorAgent,
      idempotencyKey: input.evaluationId,
      nonce: input.evaluationId,
      deadline: input.deadline,
      attempts: { maxTotal: 1, maxConcurrent: 1 },
      requirements: { harness: { id: "evaluation-harness" } },
    },
    capabilityGrants: {},
    publicSpec: true,
    sealerRole: "evaluator",
  });
  return {
    taskBytes: result.task.bytes,
    taskDigest: result.task.digest,
    submissionBytes: result.submission.bytes,
    submissionDigest: result.submission.digest,
    submissionUri: `urn:uuid:${uuid}`,
  };
}
