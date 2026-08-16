/**
 * The REAL native verdict-observation adapter (one-swap M4b, #2461): it re-verifies the operator's
 * OWN announced verdicts against durable evaluator state through the coordinator's exact gate, and
 * fails CLOSED on every derivation miss rather than announcing an unverified verdict.
 */
import { describe, expect, it, vi } from "vitest";
import { documentDigest } from "@jinn-network/task-execution-protocol";
import { VerdictCode } from "@jinn-network/marketplace-binding";
import type {
  AnnouncementRecordMaterial,
  ObservationMarketplaceEvent,
} from "@jinn-network/marketplace-projector";
import {
  buildNativeVerdictObservationAdapter,
  type NativeVerdictObservationStateReader,
} from "../../src/daemon/native-verdict-observation.js";
import type {
  NativeEvaluationArtifactRow,
  NativeEvaluationAuthority,
  NativeEvaluationRow,
} from "../../src/daemon/native-evaluator-state.js";
import type { NativeOperationId } from "../../src/daemon/native-operation-identity.js";

const EVALUATION_ID = `sha256:${"1".repeat(64)}` as NativeOperationId;
const enc = (value: string) => new TextEncoder().encode(value);

const EVALUATION_DELIVERY_BYTES = enc("exact-evaluation-delivery-record");
const EVALUATION_DELIVERY_DIGEST = documentDigest(EVALUATION_DELIVERY_BYTES);

const SUBJECT_ROLES = [
  "task",
  "submission",
  "requester-envelope",
  "admission-receipt",
  "solution-delivery",
  "solution-delivery-envelope",
  "solution-evidence",
  "solution-result",
  "evaluation-spec",
] as const;

function subjectRow(role: string): NativeEvaluationArtifactRow {
  const bytes = enc(`exact-${role}`);
  return {
    evaluationId: EVALUATION_ID,
    role,
    name: role,
    digest: documentDigest(bytes),
    bytes,
    createdAt: "2026-08-05T00:00:00Z",
  };
}

function evaluationDeliveryRow(digest: `sha256:${string}`): NativeEvaluationArtifactRow {
  return {
    evaluationId: EVALUATION_ID,
    role: "evaluation-delivery",
    name: "evaluation-delivery",
    mediaType: "application/vnd.jinn.task-execution.delivery.v1+json",
    digest,
    bytes: EVALUATION_DELIVERY_BYTES,
    createdAt: "2026-08-05T00:00:00Z",
  };
}

const AUTHORITY: NativeEvaluationAuthority = {
  requester: { signerKey: "did:key:requester", sealingTime: "2026-08-05T00:00:00Z" },
  admission: { signerKey: "did:key:admission", effectiveTime: "2026-08-05T00:00:00Z" },
  executor: {
    signerKey: "did:key:executor",
    agent: "https://agents.example/solver",
    declarationKey: "did:key:solver-declaration",
    effectiveTime: "2026-08-05T00:00:00Z",
    address: `0x${"1".repeat(40)}`,
  },
  evaluator: {
    signerKey: "did:key:evaluator",
    agent: "https://agents.example/evaluator",
    declarationKey: "did:key:evaluator-declaration",
    address: `0x${"2".repeat(40)}`,
  },
  verificationDigest: `sha256:${"3".repeat(64)}`,
};

const DERIVED = {
  taskBytes: enc("evaluation-task"),
  taskDigest: documentDigest(enc("evaluation-task")),
  submissionBytes: enc("evaluation-submission"),
  submissionDigest: documentDigest(enc("evaluation-submission")),
  submissionUri: "urn:uuid:00000000-0000-4000-8000-000000000001" as const,
  attemptUri: "urn:uuid:00000000-0000-4000-8000-000000000002" as const,
  dispatchContextDigest: `sha256:${"4".repeat(64)}` as const,
  dispatchContextBytes: enc("dispatch"),
};

function evaluationRow(overrides: Partial<NativeEvaluationRow> = {}): NativeEvaluationRow {
  return {
    evaluationId: EVALUATION_ID,
    chainId: 84532,
    coordinator: `0x${"a".repeat(40)}`,
    taskId: 7n,
    solutionAttemptIndex: 1,
    solutionRequestId: `0x${"b".repeat(64)}`,
    solutionOperator: `0x${"c".repeat(40)}`,
    evaluatorAgent: "https://agents.example/evaluator",
    source: "https://solver.example/source",
    sourceSequence: "0000000000000042",
    sourceEntryDigest: `sha256:${"d".repeat(64)}`,
    canonicalEventIdentity: "84532:tx:3",
    blockHash: `0x${"e".repeat(64)}`,
    blockNumber: 120n,
    transactionHash: `0x${"f".repeat(64)}`,
    logIndex: 3,
    subjectTaskDigest: documentDigest(enc("exact-task")),
    advertisedDeliveryDigest: documentDigest(enc("exact-solution-delivery")),
    subjectGraphDigest: `sha256:${"5".repeat(64)}`,
    state: "verdict-published",
    evaluationAttemptUri: DERIVED.attemptUri,
    evaluationRequestId: `0x${"9".repeat(64)}`,
    verdictCode: VerdictCode.Pass,
    createdAt: "2026-08-05T00:00:00Z",
    updatedAt: "2026-08-05T00:00:00Z",
    ...overrides,
  };
}

interface FakeStateOptions {
  readonly evaluations?: readonly NativeEvaluationRow[];
  readonly evaluationDeliveryDigest?: `sha256:${string}`;
  readonly authority?: NativeEvaluationAuthority | undefined;
  readonly derived?: typeof DERIVED | undefined;
}

function fakeState(options: FakeStateOptions = {}): NativeVerdictObservationStateReader {
  const evaluations = options.evaluations ?? [evaluationRow()];
  const artifacts: readonly NativeEvaluationArtifactRow[] = [
    ...SUBJECT_ROLES.map(subjectRow),
    evaluationDeliveryRow(options.evaluationDeliveryDigest ?? EVALUATION_DELIVERY_DIGEST),
  ];
  const authority = "authority" in options ? options.authority : AUTHORITY;
  const derived = "derived" in options ? options.derived : DERIVED;
  return {
    listEvaluations: () => evaluations,
    listEvaluationArtifacts: (id) => (id === EVALUATION_ID ? artifacts : []),
    listSubjectArtifacts: (id) =>
      id === EVALUATION_ID ? artifacts.filter(({ role }) => role !== "evaluation-delivery") : [],
    getEvaluation: (id) => evaluations.find((row) => row.evaluationId === id),
    getAdmissionAuthority: (id) => (id === EVALUATION_ID ? authority : undefined),
    getDerivedEvaluation: (id) => (id === EVALUATION_ID ? derived : undefined),
  } as NativeVerdictObservationStateReader;
}

function v3Event(overrides: Record<string, unknown> = {}) {
  return {
    event: "VerdictDeliveryClaimed",
    facts: {
      evaluator: `0x${"2".repeat(40)}`,
      requestId: `0x${"9".repeat(64)}`,
      taskId: 7n,
      attemptIndex: 1,
      verdictIndex: 0,
      verdictCode: VerdictCode.Pass,
      ...overrides,
    },
  } as unknown as Extract<ObservationMarketplaceEvent, { event: "VerdictDeliveryClaimed" }>;
}

function v4Event(evaluationDeliveryDigest: `0x${string}`) {
  return {
    event: "VerdictDeliveryClaimed",
    facts: {
      evaluator: `0x${"2".repeat(40)}`,
      requestId: `0x${"9".repeat(64)}`,
      evaluationDeliveryDigest,
      taskId: 7n,
      attemptIndex: 1,
      verdictIndex: 0,
      verdictCode: VerdictCode.Pass,
    },
  } as unknown as Extract<ObservationMarketplaceEvent, { event: "VerdictDeliveryClaimed" }>;
}

const MATERIAL: AnnouncementRecordMaterial = {
  kind: "evaluation-delivery",
  bytes: EVALUATION_DELIVERY_BYTES,
};

function verification(result: { ok: true; verdictCode: VerdictCode } | { ok: false; reason: string }) {
  return { verify: vi.fn(async () => result) };
}

describe("buildNativeVerdictObservationAdapter", () => {
  it.each([
    [VerdictCode.Pass, "pass"],
    [VerdictCode.Fail, "fail"],
    [VerdictCode.Unresolved, "inconclusive"],
  ] as const)(
    "re-verifies the durable aggregate and maps verdictCode %i to statement %s",
    async (verdictCode, statementVerdict) => {
      const verify = verification({ ok: true, verdictCode });
      const adapter = buildNativeVerdictObservationAdapter({
        state: fakeState({ evaluations: [evaluationRow({ verdictCode })] }),
        verification: verify,
      });
      await expect(adapter(v3Event({ verdictCode }), MATERIAL)).resolves.toEqual({
        gate: { decisionGrade: true, failures: [] },
        statementVerdict,
      });
      // Assembled from durable state — the SAME input shape the settlement path builds, no canonical.
      expect(verify.verify).toHaveBeenCalledWith(expect.objectContaining({
        evaluation: expect.objectContaining({ evaluationId: EVALUATION_ID }),
        evaluationAuthority: AUTHORITY,
        derived: DERIVED,
        subject: expect.objectContaining({ task: expect.anything(), delivery: expect.anything() }),
        artifacts: expect.arrayContaining([
          expect.objectContaining({ role: "evaluation-delivery", digest: EVALUATION_DELIVERY_DIGEST }),
        ]),
      }));
      expect(verify.verify.mock.calls[0]![0]).not.toHaveProperty("canonical");
    },
  );

  it("closes the on-chain evaluationDeliveryDigest against the announced material (V4)", async () => {
    const verify = verification({ ok: true, verdictCode: VerdictCode.Pass });
    const digestBytes32 = `0x${EVALUATION_DELIVERY_DIGEST.slice("sha256:".length)}` as `0x${string}`;
    const adapter = buildNativeVerdictObservationAdapter({ state: fakeState(), verification: verify });
    await expect(adapter(v4Event(digestBytes32), MATERIAL)).resolves.toEqual({
      gate: { decisionGrade: true, failures: [] },
      statementVerdict: "pass",
    });
  });

  it("refuses (throws) when no durable aggregate matches, without calling the gate", async () => {
    const verify = verification({ ok: true, verdictCode: VerdictCode.Pass });
    const adapter = buildNativeVerdictObservationAdapter({
      state: fakeState({ evaluations: [] }),
      verification: verify,
    });
    await expect(adapter(v3Event(), MATERIAL)).rejects.toThrow(/joins 0 durable evaluation aggregates/u);
    expect(verify.verify).not.toHaveBeenCalled();
  });

  it("refuses when the durable evaluation-delivery digest does not equal the announced material", async () => {
    const verify = verification({ ok: true, verdictCode: VerdictCode.Pass });
    const adapter = buildNativeVerdictObservationAdapter({
      state: fakeState({ evaluationDeliveryDigest: `sha256:${"7".repeat(64)}` }),
      verification: verify,
    });
    await expect(adapter(v3Event(), MATERIAL)).rejects.toThrow(/joins 0 durable evaluation aggregates/u);
    expect(verify.verify).not.toHaveBeenCalled();
  });

  it.each([
    ["verdictCode", { verdictCode: VerdictCode.Fail }],
    ["taskId", { taskId: 999n }],
    ["attemptIndex", { attemptIndex: 9 }],
    ["requestId", { requestId: `0x${"8".repeat(64)}` }],
  ] as const)("refuses when the on-chain %s disagrees with durable state", async (_label, override) => {
    const verify = verification({ ok: true, verdictCode: VerdictCode.Pass });
    const adapter = buildNativeVerdictObservationAdapter({ state: fakeState(), verification: verify });
    await expect(adapter(v3Event(override), MATERIAL)).rejects.toThrow(/durable evaluation aggregates/u);
    expect(verify.verify).not.toHaveBeenCalled();
  });

  it("refuses a V4 on-chain evaluationDeliveryDigest that disagrees with the announced material", async () => {
    const verify = verification({ ok: true, verdictCode: VerdictCode.Pass });
    const adapter = buildNativeVerdictObservationAdapter({ state: fakeState(), verification: verify });
    await expect(adapter(v4Event(`0x${"a".repeat(64)}`), MATERIAL))
      .rejects.toThrow(/evaluationDeliveryDigest .* does not equal/u);
    expect(verify.verify).not.toHaveBeenCalled();
  });

  it("refuses when the durable aggregate is missing verified authority or its sealed pair", async () => {
    const verify = verification({ ok: true, verdictCode: VerdictCode.Pass });
    const adapter = buildNativeVerdictObservationAdapter({
      state: fakeState({ authority: undefined }),
      verification: verify,
    });
    await expect(adapter(v3Event(), MATERIAL)).rejects.toThrow(/missing verified authority or its sealed/u);
    expect(verify.verify).not.toHaveBeenCalled();
  });

  it("refuses (does NOT fabricate) when the decision-grade gate itself refuses", async () => {
    const verify = verification({ ok: false, reason: "named-verdict-gate:settlement-join" });
    const adapter = buildNativeVerdictObservationAdapter({ state: fakeState(), verification: verify });
    await expect(adapter(v3Event(), MATERIAL))
      .rejects.toThrow(/decision-grade verdict gate refused .*named-verdict-gate:settlement-join/u);
    expect(verify.verify).toHaveBeenCalledTimes(1);
  });

  it("refuses a re-verified verdict code that has no decision-grade statement verdict", async () => {
    // Durable row + on-chain claim both carry Invalid(3); the gate returns it too. Invalid has no
    // decision-grade statement verdict, so the adapter refuses rather than inventing one.
    const verify = verification({ ok: true, verdictCode: VerdictCode.Invalid });
    const adapter = buildNativeVerdictObservationAdapter({
      state: fakeState({ evaluations: [evaluationRow({ verdictCode: VerdictCode.Invalid })] }),
      verification: verify,
    });
    await expect(adapter(v3Event({ verdictCode: VerdictCode.Invalid }), MATERIAL))
      .rejects.toThrow(/no decision-grade Result Evaluation Statement verdict/u);
  });

  it("refuses when the re-verified verdict code disagrees with the on-chain claim", async () => {
    // Lookup admits on the durable row's Pass; the gate returns Fail. That divergence is a refusal,
    // never a silent re-label.
    const verify = verification({ ok: true, verdictCode: VerdictCode.Fail });
    const adapter = buildNativeVerdictObservationAdapter({ state: fakeState(), verification: verify });
    await expect(adapter(v3Event(), MATERIAL)).rejects.toThrow(/does not equal the on-chain claim/u);
  });
});
