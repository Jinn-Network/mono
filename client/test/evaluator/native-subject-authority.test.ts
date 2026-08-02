import { describe, expect, it } from "vitest";
import {
  TASK_EXECUTION_PROTOCOL_URI,
  documentDigest,
  sealDelivery,
  sealSubmission,
  sealTask,
} from "@jinn-network/task-execution-protocol";
import {
  verifyNativeSubjectAuthority,
  type NativeSubjectAuthorityClaim,
  type NativeSubjectAuthorityDependencies,
} from "../../src/evaluator/native-subject-authority.js";
import type { ExactSubjectArtifact, SubjectMaterial } from "../../src/evaluator/subject-material.js";

const REQUESTER = "https://agents.example/requester";
const ADMISSION = "https://agents.example/admission";
const EXECUTOR = "https://agents.example/executor";
const EVALUATOR = "https://agents.example/evaluator";
const REQUESTER_KEY = "did:key:requester";
const ADMISSION_KEY = "did:key:admission";
const EXECUTOR_KEY = "did:key:executor";
const EVALUATOR_KEY = "did:key:evaluator";
const NOW = "2026-08-02T10:00:00Z";

function artifact(name: string, bytes: Uint8Array): ExactSubjectArtifact {
  return { name, bytes, digest: documentDigest(bytes) };
}

function envelope(payloadType: string, payload: Uint8Array, keyid: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    payloadType,
    payload: Buffer.from(payload).toString("base64"),
    signatures: [{ keyid, sig: Buffer.from("signature").toString("base64") }],
  }));
}

function fixture(): { material: SubjectMaterial; claim: NativeSubjectAuthorityClaim } {
  const evaluationSpec = artifact("evaluation-spec", new TextEncoder().encode('{"spec":"exact"}'));
  const result = artifact("prediction", new TextEncoder().encode('{"probabilityYes":"0.75"}'));
  const evidence = artifact("execution-evidence", new TextEncoder().encode('{"evidence":"exact"}'));
  const taskBytes = sealTask({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    profile: { uri: "https://jinn.network/task-profiles/prediction-forecast/1.0", digest: { sha256: "1".repeat(64) } },
    instructions: "forecast",
    outputs: [{ name: "prediction", mediaType: "application/json", required: true }],
    evaluation: { name: "evaluation-spec", digest: { sha256: evaluationSpec.digest.slice(7) } },
  });
  const task = artifact("task", taskBytes);
  const receiptStatement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [
      { name: "task", digest: { sha256: task.digest.slice(7) } },
      { name: "evaluation-spec", digest: { sha256: evaluationSpec.digest.slice(7) } },
    ],
    predicateType: "https://jinn.network/admission/prediction/1",
    predicate: { issuer: ADMISSION },
  };
  const receipt = artifact("admission-receipt", envelope(
    "application/vnd.in-toto+json",
    new TextEncoder().encode(JSON.stringify(receiptStatement)),
    ADMISSION_KEY,
  ));
  const submissionBytes = sealSubmission({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    submission: "urn:uuid:00000000-0000-4000-8000-000000000010",
    task: { digest: { sha256: task.digest.slice(7) } },
    requester: REQUESTER,
    idempotencyKey: "native-authority-test",
    nonce: "nonce",
    deadline: "2026-08-03T00:00:00Z",
    annotations: {
      "https://jinn.network/annotations/admission-receipt/1.0": {
        name: "admission-receipt",
        digest: { sha256: receipt.digest.slice(7) },
      },
    },
  });
  const submission = artifact("submission", submissionBytes);
  const deliveryBytes = sealDelivery({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    attempt: "urn:uuid:00000000-0000-4000-8000-000000000011",
    task: task.digest,
    outputs: [{ name: result.name, digest: { sha256: result.digest.slice(7) } }],
    evidenceRecords: [{ family: "execution-evidence", digest: evidence.digest }],
    outcome: "fulfilled",
    createdAt: NOW,
  });
  const delivery = artifact("delivery", deliveryBytes);
  return {
    material: {
      task,
      submission,
      requesterEnvelope: artifact("requester-envelope", envelope(
        "application/vnd.jinn.task-execution.submission.v1+json",
        submissionBytes,
        REQUESTER_KEY,
      )),
      admissionReceipt: receipt,
      delivery,
      deliveryEnvelope: artifact("delivery-envelope", envelope(
        "application/vnd.jinn.task-execution.delivery.v1+json",
        deliveryBytes,
        EXECUTOR_KEY,
      )),
      evidenceRecords: [evidence],
      results: [result],
      evaluationSpec,
    },
    claim: {
      requester: { signerKey: REQUESTER_KEY, sealingTime: NOW },
      admission: { signerKey: ADMISSION_KEY, effectiveTime: NOW },
      executor: {
        signerKey: EXECUTOR_KEY,
        agent: EXECUTOR,
        declarationKey: EXECUTOR_KEY,
        address: "0x1111111111111111111111111111111111111111",
      },
      evaluator: {
        signerKey: EVALUATOR_KEY,
        agent: EVALUATOR,
        declarationKey: EVALUATOR_KEY,
        address: "0x2222222222222222222222222222222222222222",
      },
    },
  };
}

function dependencies(input: {
  readonly missingKey?: string;
  readonly evaluatorFailure?: string;
} = {}): NativeSubjectAuthorityDependencies {
  return {
    bindingResolver: {
      async resolveBinding({ key, agent }) {
        if (key === input.missingKey) return null;
        const scope = key === REQUESTER_KEY
          ? ["authorizations"]
          : key === ADMISSION_KEY
            ? ["https://jinn.network/trust-scopes/admission-receipts/1.0"]
            : key === EXECUTOR_KEY ? ["deliveries"] : ["verdicts"];
        return {
          binding: {
            agent,
            relationship: "signs-for",
            scope,
            strength: "strong",
            ceremony: { type: "oidc-machine", digest: `sha256:${"a".repeat(64)}` },
          },
          effectiveStart: "2026-01-01T00:00:00Z",
          isGenesis: true,
          revocations: [],
        } as never;
      },
    },
    witnessVerifier: { verify1271Witness: async () => ({ verified: true }) },
    dsseVerifier: (bytes) => {
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { signatures: Array<{ keyid: string }> };
      return { validSignerKeyids: parsed.signatures.map(({ keyid }) => keyid), diagnostics: [] };
    },
    requesterPolicy: { accepted: [REQUESTER], requiredStrength: "strong" },
    admissionAgentPolicy: { accepted: [ADMISSION], requiredStrength: "strong" },
    executorPolicy: { accepted: [EXECUTOR], requiredStrength: "strong" },
    evaluatorAuthority: {
      resolve: async (authority) => input.evaluatorFailure === undefined
        && authority.signerKey === EVALUATOR_KEY
        && authority.declarationKey === EVALUATOR_KEY
        && authority.agent === EVALUATOR
        && authority.address === "0x2222222222222222222222222222222222222222"
        ? { ok: true }
        : { ok: false, reason: input.evaluatorFailure ?? "wrong-key" },
    },
  };
}

describe("verifyNativeSubjectAuthority", () => {
  it("authenticates the exact subject graph and produces a durable decision digest", async () => {
    const value = fixture();
    await expect(verifyNativeSubjectAuthority({ ...value, dependencies: dependencies() }))
      .resolves.toMatchObject({
        requester: { signerKey: REQUESTER_KEY },
        executor: { signerKey: EXECUTOR_KEY, effectiveTime: NOW },
        evaluator: { agent: EVALUATOR },
        verificationDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      });
  });

  it("fails before claim when the requester envelope does not carry the exact Submission", async () => {
    const value = fixture();
    const material = {
      ...value.material,
      requesterEnvelope: artifact("requester-envelope", envelope(
        "application/vnd.jinn.task-execution.submission.v1+json",
        new TextEncoder().encode("tampered"),
        REQUESTER_KEY,
      )),
    };
    await expect(verifyNativeSubjectAuthority({ material, claim: value.claim, dependencies: dependencies() }))
      .rejects.toMatchObject({ reason: "requester-payload-mismatch" });
  });

  it("fails closed when an effective-time executor binding cannot be resolved", async () => {
    const value = fixture();
    await expect(verifyNativeSubjectAuthority({ ...value, dependencies: dependencies({ missingKey: EXECUTOR_KEY }) }))
      .rejects.toMatchObject({ reason: "executor-binding-failed" });
  });

  it("refuses a solver identity reused as evaluator authority", async () => {
    const value = fixture();
    const claim = {
      ...value.claim,
      evaluator: { ...value.claim.evaluator, agent: EXECUTOR },
    };
    await expect(verifyNativeSubjectAuthority({ material: value.material, claim, dependencies: dependencies() }))
      .rejects.toMatchObject({ reason: "self-evaluation-refused" });
  });

  it.each(["revoked", "expired", "wrong-scope", "wrong-key"])(
    "fails closed when B2 evaluator effective authority reports %s",
    async (evaluatorFailure) => {
      const value = fixture();
      await expect(verifyNativeSubjectAuthority({
        ...value,
        dependencies: dependencies({ evaluatorFailure }),
      })).rejects.toMatchObject({ reason: "evaluator-binding-failed" });
    },
  );
});
