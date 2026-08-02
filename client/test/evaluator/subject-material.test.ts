import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  EVALUATION_SPEC_FORMAT_URI,
  sealEvaluationSpec,
  type EvaluationSpec,
} from "@jinn-network/task-execution-profiles";
import {
  TASK_EXECUTION_PROTOCOL_URI,
  documentDigest,
  sealDelivery,
  sealSubmission,
  sealTask,
} from "@jinn-network/task-execution-protocol";
import { acquireSubjectMaterial, SubjectMaterialError } from "../../src/evaluator/subject-material.js";

const PROFILE_URI = "https://jinn.network/task-profiles/repository-work/1.0";
const PROFILE_DIGEST_HEX = "6".repeat(64);
const sha256 = (bytes: Uint8Array) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const;

const evaluationSpecDocument: EvaluationSpec = {
  protocol: EVALUATION_SPEC_FORMAT_URI,
  semanticsVersion: "4",
  family: "deterministic-process",
  grader: { uri: "https://jinn.network/graders/subject-material-fixture" },
  familyBlock: {
    image: { uri: "https://jinn.network/images/subject-material-fixture" },
    platform: "linux/amd64",
    workspace: { root: "/workspace" },
    testMaterial: [],
    parser: {
      id: "jinn.parser.subject-material-fixture",
      version: "1.0.0",
      digest: `sha256:${"7".repeat(64)}`,
    },
    transitions: { failToPass: [], passToPass: [] },
    timeout: 60,
  },
  measurements: [{ name: "passed", type: "boolean", required: true }],
  verdictRule: { threshold: { measurement: "passed", op: "eq", value: true } },
  unscorable: [],
  evidenceConventions: { requiredRefs: [] },
};

function fixtures() {
  const spec = sealEvaluationSpec(evaluationSpecDocument);
  const resultBytes = new TextEncoder().encode("result-artifact");
  const evidenceBytes = new TextEncoder().encode("execution-evidence");
  const taskBytes = sealTask({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    profile: { uri: PROFILE_URI, digest: { sha256: PROFILE_DIGEST_HEX } },
    instructions: "Subject material fixture task.",
    outputs: [{ name: "patch", mediaType: "text/plain", required: true }],
    evaluation: { name: "evaluation-spec.json", digest: { sha256: spec.digest.slice("sha256:".length) } },
  });
  const submissionBytes = sealSubmission({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    submission: "urn:uuid:00000000-0000-4000-8000-000000000003",
    task: { digest: { sha256: documentDigest(taskBytes).slice("sha256:".length) } },
    requester: "https://agents.example/jinn/requester",
    idempotencyKey: "subject-material",
    nonce: "fixture-nonce",
    deadline: "2026-08-01T00:00:00Z",
  });
  const deliveryBytes = sealDelivery({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    attempt: "urn:uuid:00000000-0000-4000-8000-000000000001",
    task: documentDigest(taskBytes),
    outputs: [{ name: "patch", digest: { sha256: documentDigest(resultBytes).slice("sha256:".length) } }],
    evidenceRecords: [{ family: "execution-evidence", digest: documentDigest(evidenceBytes) }],
    outcome: "fulfilled",
    createdAt: "2026-07-30T00:00:00Z",
  });
  const requesterEnvelopeBytes = new TextEncoder().encode("requester-dsse-envelope");
  const admissionReceiptBytes = new TextEncoder().encode("admission-receipt-envelope");
  const byDigest = new Map([
    [documentDigest(taskBytes), taskBytes],
    [documentDigest(submissionBytes), submissionBytes],
    [documentDigest(resultBytes), resultBytes],
    [documentDigest(evidenceBytes), evidenceBytes],
    [spec.digest, spec.bytes],
    [documentDigest(requesterEnvelopeBytes), requesterEnvelopeBytes],
    [documentDigest(admissionReceiptBytes), admissionReceiptBytes],
  ]);
  return {
    deliveryBytes,
    byDigest,
    references: {
      submission: { digest: documentDigest(submissionBytes) },
      requesterEnvelope: { digest: documentDigest(requesterEnvelopeBytes) },
      admissionReceipt: { digest: documentDigest(admissionReceiptBytes) },
    },
  };
}

function opportunity(deliveryBytes: Uint8Array) {
  return {
    deliveryCid: "bafyDelivery",
    advertisedDeliveryDigest: sha256(deliveryBytes),
  } as never;
}

describe("acquireSubjectMaterial", () => {
  it("retrieves exact Task, Submission, requester envelope, receipt, Delivery, evidence, outputs, and EvaluationSpec", async () => {
    const f = fixtures();
    const material = await acquireSubjectMaterial(
      opportunity(f.deliveryBytes),
      f.references,
      {
        byCid: async () => f.deliveryBytes,
        byDigest: async (digest) => {
          const bytes = f.byDigest.get(digest);
          if (bytes === undefined) throw new Error(`unexpected digest ${digest}`);
          return bytes;
        },
      },
    );

    expect(material.task.bytes).toEqual(f.byDigest.get(material.task.digest));
    expect(material.submission.bytes).toEqual(f.byDigest.get(material.submission.digest));
    expect(material.requesterEnvelope.bytes).toEqual(f.byDigest.get(material.requesterEnvelope.digest));
    expect(material.admissionReceipt.bytes).toEqual(f.byDigest.get(material.admissionReceipt.digest));
    expect(material.delivery.bytes).toEqual(f.deliveryBytes);
    expect(material.evidenceRecords).toHaveLength(1);
    expect(material.results).toHaveLength(1);
    expect(material.evaluationSpec.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("refuses Delivery bytes tampered after the external advertised digest was committed", async () => {
    const f = fixtures();
    await expect(acquireSubjectMaterial(
      opportunity(f.deliveryBytes),
      f.references,
      {
        byCid: async () => new TextEncoder().encode("tampered Delivery bytes"),
        byDigest: async (digest) => f.byDigest.get(digest)!,
      },
    )).rejects.toMatchObject({ kind: "digest-mismatch" });
  });

  it("refuses a subject Task that declares no EvaluationSpec", async () => {
    const f = fixtures();
    const taskWithoutEvaluation = sealTask({
      protocol: TASK_EXECUTION_PROTOCOL_URI,
      profile: { uri: PROFILE_URI, digest: { sha256: PROFILE_DIGEST_HEX } },
      instructions: "No spec.",
      outputs: [],
    });
    const deliveryWithoutEvaluation = sealDelivery({
      protocol: TASK_EXECUTION_PROTOCOL_URI,
      attempt: "urn:uuid:00000000-0000-4000-8000-000000000002",
      task: documentDigest(taskWithoutEvaluation),
      outputs: [],
      outcome: "fulfilled",
      createdAt: "2026-07-30T00:00:00Z",
    });
    f.byDigest.set(documentDigest(taskWithoutEvaluation), taskWithoutEvaluation);

    await expect(acquireSubjectMaterial(
      opportunity(deliveryWithoutEvaluation),
      f.references,
      {
        byCid: async () => deliveryWithoutEvaluation,
        byDigest: async (digest) => f.byDigest.get(digest)!,
      },
    )).rejects.toBeInstanceOf(SubjectMaterialError);
  });
});
