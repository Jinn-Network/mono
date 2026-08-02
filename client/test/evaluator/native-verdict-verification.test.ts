import { describe, expect, it, vi } from "vitest";
import {
  IN_TOTO_STATEMENT_TYPE,
  RESULT_EVALUATION_PREDICATE_TYPE,
  buildVerdictEnvelope,
} from "@jinn-network/task-execution-profiles";
import {
  TASK_EXECUTION_PROTOCOL_URI,
  documentDigest,
  sealDelivery,
} from "@jinn-network/task-execution-protocol";
import { buildNativeEvaluatorVerdictVerification } from "../../src/evaluator/native-verdict-verification.js";

const exact = (name: string, bytes: Uint8Array) => ({ name, bytes, digest: documentDigest(bytes) });
const text = (value: string) => new TextEncoder().encode(value);
const ATTEMPT = "urn:uuid:00000000-0000-4000-8000-000000000030" as const;
const EVALUATOR = "https://agents.example/evaluator";

function fixture() {
  const task = exact("task", text("exact-task"));
  const result = exact("prediction", text("exact-result"));
  const solutionEvidence = exact("solution-evidence", text("solution-evidence"));
  const solutionDeliveryBytes = sealDelivery({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    attempt: "urn:uuid:00000000-0000-4000-8000-000000000031",
    task: task.digest,
    outputs: [{ name: result.name, digest: { sha256: result.digest.slice(7) } }],
    evidenceRecords: [{ family: "execution-evidence", digest: solutionEvidence.digest }],
    outcome: "fulfilled",
    createdAt: "2026-08-02T10:00:00Z",
  });
  const subject = {
    task,
    submission: exact("submission", text("exact-submission")),
    requesterEnvelope: exact("requester-envelope", text("requester-envelope")),
    admissionReceipt: exact("admission-receipt", text("admission-receipt")),
    delivery: exact("delivery", solutionDeliveryBytes),
    deliveryEnvelope: exact("delivery-envelope", text("solution-delivery-envelope")),
    evidenceRecords: [solutionEvidence],
    results: [result],
    evaluationSpec: exact("evaluation-spec", text("evaluation-spec")),
  };
  const verdictEnvelope = buildVerdictEnvelope({
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: [
      { name: "task", digest: { sha256: task.digest.slice(7) } },
      { name: result.name, digest: { sha256: result.digest.slice(7) } },
    ],
    predicateType: RESULT_EVALUATION_PREDICATE_TYPE,
    predicate: {
      evaluatedAt: "2026-08-02T11:00:00Z",
      evaluator: { id: EVALUATOR },
      taskSubject: task.digest,
      resultSubjects: [result.digest],
      verdict: "pass",
    },
  }, [{ keyid: "did:key:evaluator", sig: "c2ln" }]);
  const verdictBytes = text(JSON.stringify(verdictEnvelope));
  const evaluationEvidence = exact("evaluation-evidence", text("evaluation-evidence"));
  const derivedTaskBytes = text("exact-derived-task");
  const derivedTaskDigest = documentDigest(derivedTaskBytes);
  const evaluationDeliveryBytes = sealDelivery({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    attempt: ATTEMPT,
    task: derivedTaskDigest,
    outputs: [{ name: "verdict", digest: { sha256: documentDigest(verdictBytes).slice(7) } }],
    evidenceRecords: [{ family: "execution-evidence", digest: evaluationEvidence.digest }],
    outcome: "fulfilled",
    createdAt: "2026-08-02T11:05:00Z",
  });
  const evaluationDelivery = exact("evaluation-delivery", evaluationDeliveryBytes);
  const artifacts = [
    { role: "verdict", evaluationId: `sha256:${"1".repeat(64)}`, createdAt: "2026-08-02T11:05:00Z", ...exact("verdict", verdictBytes) },
    { role: "evaluation-delivery", evaluationId: `sha256:${"1".repeat(64)}`, createdAt: "2026-08-02T11:05:00Z", ...evaluationDelivery },
    { role: "evaluation-delivery-envelope", evaluationId: `sha256:${"1".repeat(64)}`, createdAt: "2026-08-02T11:05:00Z", ...exact("evaluation-delivery-envelope", text("evaluation-delivery-envelope")) },
    { role: "evaluation-evidence", evaluationId: `sha256:${"1".repeat(64)}`, createdAt: "2026-08-02T11:05:00Z", ...evaluationEvidence },
  ];
  return {
    evaluation: {
      evaluatorAgent: EVALUATOR,
      evaluationAttemptUri: ATTEMPT,
    },
    evaluationAuthority: {
      requester: { signerKey: "did:key:requester", sealingTime: "2026-08-02T09:00:00Z" },
      admission: { signerKey: "did:key:admission", effectiveTime: "2026-08-02T09:30:00Z" },
      executor: {
        signerKey: "did:key:executor",
        agent: "https://agents.example/solver",
        declarationKey: "did:key:solver-declaration",
        effectiveTime: "2026-08-02T10:00:00Z",
        address: `0x${"1".repeat(40)}`,
      },
      evaluator: {
        signerKey: "did:key:evaluator",
        agent: EVALUATOR,
        declarationKey: "did:key:evaluator-declaration",
        address: `0x${"2".repeat(40)}`,
      },
      verificationDigest: `sha256:${"3".repeat(64)}`,
    },
    subject,
    derived: {
      taskBytes: derivedTaskBytes,
      taskDigest: derivedTaskDigest,
      submissionBytes: text("evaluation-submission"),
      submissionDigest: documentDigest(text("evaluation-submission")),
      submissionUri: "urn:uuid:00000000-0000-4000-8000-000000000032",
      attemptUri: ATTEMPT,
      dispatchContextDigest: `sha256:${"4".repeat(64)}`,
      dispatchContextBytes: text("dispatch"),
    },
    artifacts,
  } as never;
}

function dependencies(input: { evaluationAuthorityOk?: boolean; gateOk?: boolean } = {}) {
  const gate = vi.fn(async () => input.gateOk === false
    ? { decisionGrade: false, failures: [{ check: "settlement-join", detail: "revoked" }] }
    : { decisionGrade: true, failures: [] });
  return {
    gate,
    value: {
      gate: { gate },
      solutionDeliveryAuthority: { verify: async () => ({ ok: true as const }) },
      evaluationDeliveryAuthority: {
        verify: async () => input.evaluationAuthorityOk === false
          ? { ok: false as const, reason: "revoked" }
          : { ok: true as const },
      },
      preSettlementClaimTime: async () => "2026-08-02T11:10:00Z",
      blockTime: async () => "2026-08-02T11:15:00Z",
    },
  };
}

describe("buildNativeEvaluatorVerdictVerification", () => {
  it("authenticates both Delivery envelopes, exact evidence/output graph, and every named gate input", async () => {
    const deps = dependencies();
    await expect(buildNativeEvaluatorVerdictVerification(deps.value).verify(fixture()))
      .resolves.toEqual({ ok: true, verdictCode: 1 });
    expect(deps.gate).toHaveBeenCalledWith(expect.objectContaining({
      settlement: expect.objectContaining({
        subjectSubmissionBytes: expect.any(Uint8Array),
        evaluationSpecBytes: expect.any(Uint8Array),
        evaluationTaskBytes: expect.any(Uint8Array),
      }),
      requesterAuthentication: expect.objectContaining({ signerKey: "did:key:requester" }),
      admissionReceipt: expect.objectContaining({ signerKey: "did:key:admission" }),
      verdict: expect.objectContaining({
        signerKey: "did:key:evaluator",
        settlementDeclarationKey: "did:key:evaluator-declaration",
        onChainVerdictCode: 1,
      }),
    }));
  });

  it("rejects a noncanonical evaluation Delivery before authority or named checks", async () => {
    const input = fixture() as ReturnType<typeof fixture>;
    const row = input.artifacts.find(({ role }: { role: string }) => role === "evaluation-delivery")!;
    const pretty = text(JSON.stringify(JSON.parse(new TextDecoder().decode(row.bytes)), null, 2));
    row.bytes = pretty;
    row.digest = documentDigest(pretty);
    const deps = dependencies();
    await expect(buildNativeEvaluatorVerdictVerification(deps.value).verify(input))
      .resolves.toEqual({ ok: false, reason: "evaluation-record-graph-invalid" });
    expect(deps.gate).not.toHaveBeenCalled();
  });

  it("fails closed on revoked evaluation Delivery authority", async () => {
    const deps = dependencies({ evaluationAuthorityOk: false });
    await expect(buildNativeEvaluatorVerdictVerification(deps.value).verify(fixture()))
      .resolves.toEqual({ ok: false, reason: "evaluation-delivery-authority:revoked" });
    expect(deps.gate).not.toHaveBeenCalled();
  });

  it("propagates named gate failures instead of publishing a decision-grade flag", async () => {
    const deps = dependencies({ gateOk: false });
    await expect(buildNativeEvaluatorVerdictVerification(deps.value).verify(fixture()))
      .resolves.toEqual({ ok: false, reason: "named-verdict-gate:settlement-join" });
  });
});
