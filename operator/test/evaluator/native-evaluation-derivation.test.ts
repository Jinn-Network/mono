import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  EVALUATION_SPEC_FORMAT_URI,
  sealEvaluationSpec,
  type EvaluationSpec,
} from "@jinn-network/task-execution-profiles";
import {
  SubmissionRecordSchema,
  TASK_EXECUTION_PROTOCOL_URI,
  documentDigest,
  sealDelivery,
  sealSubmission,
  sealTask,
} from "@jinn-network/task-execution-protocol";
import { ADMISSION_RECEIPT_ANNOTATION_URI } from "@jinn-network/marketplace-binding";
import { deriveNativeEvaluation } from "../../src/evaluator/native-evaluation-derivation.js";

const digest = (bytes: Uint8Array) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const;
const exact = (name: string, bytes: Uint8Array) => ({ name, bytes, digest: digest(bytes) });

function material() {
  const receiptBytes = new TextEncoder().encode("receipt-envelope");
  const receiptDigest = digest(receiptBytes);
  const spec: EvaluationSpec = {
    protocol: EVALUATION_SPEC_FORMAT_URI,
    semanticsVersion: "4",
    family: "deterministic-process",
    grader: { name: "prediction-v1", digest: { sha256: "1".repeat(64) } },
    familyBlock: {
      image: { name: "prediction-evaluator", digest: { sha256: "3".repeat(64) } },
      platform: "linux/amd64",
      workspace: { root: "/workspace" },
      testMaterial: [],
      parser: {
        id: "jinn.parser.prediction-v1",
        version: "1.0.0",
        digest: `sha256:${"4".repeat(64)}`,
      },
      transitions: { failToPass: [], passToPass: [] },
      timeout: 60,
    },
    measurements: [{ name: "integrity", type: "boolean", required: true }],
    verdictRule: { threshold: { measurement: "integrity", op: "eq", value: true } },
    unscorable: [],
    evidenceConventions: { requiredRefs: [] },
  } as EvaluationSpec;
  const sealedSpec = sealEvaluationSpec(spec);
  const taskBytes = sealTask({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    profile: {
      uri: "https://spec.jinn.network/task-profiles/prediction-forecast/1.0",
      digest: { sha256: "2".repeat(64) },
    },
    instructions: "forecast",
    outputs: [{ name: "prediction", mediaType: "application/json", required: true }],
    evaluation: { name: "evaluation-spec", digest: { sha256: sealedSpec.digest.slice(7) } },
  });
  const submissionBytes = sealSubmission({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    submission: "urn:uuid:10000000-0000-4000-8000-000000000001",
    task: { digest: { sha256: documentDigest(taskBytes).slice(7) } },
    requester: "urn:jinn:requester:golden",
    idempotencyKey: "subject",
    nonce: "subject",
    deadline: "2030-01-01T00:00:00.000Z",
    annotations: {
      [ADMISSION_RECEIPT_ANNOTATION_URI]: {
        name: "admission-receipt",
        digest: { sha256: receiptDigest.slice(7) },
      },
    },
  });
  const resultBytes = new TextEncoder().encode('{"probability":0.6}');
  const deliveryBytes = sealDelivery({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    attempt: "urn:uuid:20000000-0000-4000-8000-000000000002",
    task: documentDigest(taskBytes),
    outputs: [{ name: "prediction", digest: { sha256: digest(resultBytes).slice(7) } }],
    outcome: "fulfilled",
    createdAt: "2026-08-02T00:00:00.000Z",
  });
  return {
    task: exact("task", taskBytes),
    submission: exact("submission", submissionBytes),
    requesterEnvelope: exact("requester-envelope", new TextEncoder().encode("requester-envelope")),
    admissionReceipt: exact("admission-receipt", receiptBytes),
    delivery: exact("delivery", deliveryBytes),
    deliveryEnvelope: exact("delivery-envelope", new TextEncoder().encode("delivery-envelope")),
    evidenceRecords: [],
    results: [exact("prediction", resultBytes)],
    evaluationSpec: exact("evaluation-spec", sealedSpec.bytes),
  };
}

describe("deriveNativeEvaluation", () => {
  it("derives deterministic pair-fixed Task and grant-free evaluator Submission", () => {
    const input = {
      evaluationId: `sha256:${"a".repeat(64)}` as const,
      evaluatorAgent: "urn:jinn:evaluator:golden",
      material: material(),
      deadline: "2026-08-03T00:00:00.000Z",
    };
    const first = deriveNativeEvaluation(input);
    const second = deriveNativeEvaluation(input);
    expect(second.taskBytes).toEqual(first.taskBytes);
    expect(second.submissionBytes).toEqual(first.submissionBytes);
    expect(first.taskDigest).toBe(documentDigest(first.taskBytes));
    expect(first.submissionDigest).toBe(documentDigest(first.submissionBytes));
    const submission = SubmissionRecordSchema.parse(JSON.parse(new TextDecoder().decode(first.submissionBytes)));
    expect(submission.capabilityGrants).toBeUndefined();
    expect(submission.requester).toBe("urn:jinn:evaluator:golden");
    expect(submission.requirements).toEqual({ harness: { id: "evaluation-harness" } });
    expect(submission.idempotencyKey).toBe(input.evaluationId);
  });

  it("fails when any exact subject graph digest is inconsistent", () => {
    const tampered = material();
    tampered.requesterEnvelope = {
      ...tampered.requesterEnvelope,
      bytes: new TextEncoder().encode("tampered"),
    };
    expect(() => deriveNativeEvaluation({
      evaluationId: `sha256:${"a".repeat(64)}`,
      evaluatorAgent: "urn:jinn:evaluator:golden",
      material: tampered,
      deadline: "2026-08-03T00:00:00.000Z",
    })).toThrow(/digest mismatch/);
  });
});
