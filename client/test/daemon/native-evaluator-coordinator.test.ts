import { describe, expect, it, vi } from "vitest";
import {
  TASK_EXECUTION_PROTOCOL_URI,
  documentDigest,
  sealDelivery,
  sealSubmission,
} from "@jinn-network/task-execution-protocol";
import { Store } from "../../src/store/store.js";
import { NativeEvaluatorStateRepository } from "../../src/daemon/native-evaluator-state.js";
import { NativeEvaluatorCoordinator } from "../../src/daemon/native-evaluator-coordinator.js";

const artifact = (name: string, value: string) => {
  const bytes = new TextEncoder().encode(value);
  return { name, bytes, digest: documentDigest(bytes) };
};
const subject = {
  task: artifact("task", "subject-task"),
  submission: artifact("submission", "subject-submission"),
  requesterEnvelope: artifact("requester-envelope", "requester-envelope"),
  admissionReceipt: artifact("admission-receipt", "admission-receipt"),
  delivery: artifact("delivery", "solution-delivery"),
  deliveryEnvelope: artifact("delivery-envelope", "solution-delivery-envelope"),
  evidenceRecords: [artifact("solution-evidence", "solution-evidence")],
  results: [artifact("prediction", "prediction")],
  evaluationSpec: artifact("evaluation-spec", "evaluation-spec"),
};
const evaluatorAddress = `0x${"2".repeat(40)}` as const;
const requestId = `0x${"5".repeat(64)}` as const;

function setup() {
  const store = new Store(":memory:");
  const state = new NativeEvaluatorStateRepository(store, {
    now: () => new Date("2026-08-02T12:00:00Z"),
  });
  const admitted = state.admitOpportunity({
    opportunity: {
      source: "https://solver.example/source",
      sourceSequence: "0000000000000001",
      sourceEntryDigest: `sha256:${"a".repeat(64)}`,
      canonical: true,
      finality: "finalized",
      chainId: 84532,
      taskId: 7n,
      attemptIndex: 1,
      solutionRequestId: `0x${"b".repeat(64)}`,
      operatorAddress: `0x${"1".repeat(40)}`,
      deliveryCid: "bafysolution",
      advertisedDeliveryDigest: subject.delivery.digest,
      blockHash: `0x${"c".repeat(64)}`,
      blockNumber: 100n,
      transactionHash: `0x${"d".repeat(64)}`,
      logIndex: 3,
      canonicalEventIdentity: `84532:0x${"c".repeat(64)}:3`,
    },
    evaluatorAgent: "https://agents.example/evaluator",
    coordinator: `0x${"f".repeat(40)}`,
    material: subject,
  });
  state.recordAdmissionVerified(admitted.evaluationId, {
    requester: { signerKey: "did:key:requester", sealingTime: "2026-08-02T10:00:00Z" },
    admission: { signerKey: "did:key:admission", effectiveTime: "2026-08-02T10:00:00Z" },
    executor: {
      signerKey: "did:key:executor",
      agent: "https://agents.example/solver",
      declarationKey: "did:key:solver-declaration",
      effectiveTime: "2026-08-02T10:30:00Z",
      address: `0x${"1".repeat(40)}`,
    },
    evaluator: {
      signerKey: "did:key:evaluator",
      agent: "https://agents.example/evaluator",
      declarationKey: "did:key:evaluator-declaration",
      address: evaluatorAddress,
    },
    verificationDigest: `sha256:${"e".repeat(64)}`,
  });
  const taskBytes = new TextEncoder().encode("exact-evaluation-task");
  const taskDigest = documentDigest(taskBytes);
  const submissionBytes = sealSubmission({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    submission: "urn:uuid:00000000-0000-4000-8000-000000000020",
    task: { digest: { sha256: taskDigest.slice(7) } },
    requester: "https://agents.example/evaluator",
    idempotencyKey: admitted.evaluationId,
    nonce: admitted.evaluationId,
    deadline: "2026-08-03T00:00:00Z",
  });
  state.recordDerivedEvaluation(admitted.evaluationId, {
    taskBytes,
    taskDigest,
    submissionBytes,
    submissionDigest: documentDigest(submissionBytes),
    submissionUri: "urn:uuid:00000000-0000-4000-8000-000000000020",
  });
  return { store, state, id: admitted.evaluationId, taskDigest };
}

describe("NativeEvaluatorCoordinator", () => {
  it("recovers one durable evaluation through claim, backend, publication, Deliver, and separately finalized settlement", async () => {
    const { state, id, taskDigest } = setup();
    const calls: string[] = [];
    let attemptOpened = false;
    let delivered = false;
    let settled = false;
    const claimTx = { hash: `0x${"3".repeat(64)}`, blockNumber: 101n, blockHash: `0x${"4".repeat(64)}` };
    const deliverTx = { hash: `0x${"6".repeat(64)}`, blockNumber: 102n, blockHash: `0x${"7".repeat(64)}` };
    const settleTx = { hash: `0x${"8".repeat(64)}`, blockNumber: 103n, blockHash: `0x${"9".repeat(64)}` };
    const verdictBytes = new TextEncoder().encode("signed-verdict-envelope");
    const evidenceBytes = new TextEncoder().encode("evaluation-evidence");
    let actualDelivery = new Uint8Array();

    const coordinator = new NativeEvaluatorCoordinator({
      state,
      backend: {
        recover: async () => ({ classification: "absent" }),
        submit: async (_task, _submission, engagement) => {
          calls.push("backend-submit");
          const persistedDispatch = state.getDerivedEvaluation(id)!;
          expect(persistedDispatch.dispatchContextBytes).not.toBeNull();
          expect(documentDigest(persistedDispatch.dispatchContextBytes!))
            .toBe(persistedDispatch.dispatchContextDigest);
          expect(JSON.parse(new TextDecoder().decode(persistedDispatch.dispatchContextBytes!)))
            .toEqual(engagement!.dispatchContext);
          const parsed = DeliveryRecordForAttempt(engagement!.attemptUri, taskDigest, verdictBytes, evidenceBytes);
          actualDelivery = parsed;
          return { accepted: true } as never;
        },
        observe: async () => ({ descriptor: { derived: { terminal: true, state: "delivered" } } }) as never,
        deliveries: async () => [{ digest: documentDigest(actualDelivery), uri: "memory:delivery" }] as never,
        fetchDelivery: async () => actualDelivery,
        fetchArtifact: async () => verdictBytes,
        capabilities: async () => ({}) as never,
      },
      authority: {
        claim: async () => { throw new Error("authority was already persisted"); },
        dependencies: {} as never,
      },
      deadline: () => "2026-08-03T00:00:00Z",
      evaluatorAddress,
      verdictPorts: {
        canOpenVerdictAttempt: async () => ({ ok: true }),
        openVerdictAttempt: async ({ operationId }) => {
          calls.push("evaluation-claim");
          attemptOpened = true;
          return { operationId, requestId, verdictIndex: 0, transaction: claimTx };
        },
        readCanonicalVerdictAttempt: async () => attemptOpened ? ({
          taskId: 7n,
          attemptIndex: 1,
          verdictIndex: 0,
          requestId,
          evaluator: evaluatorAddress,
          transaction: { ...claimTx, logIndex: 1 },
        }) : undefined,
        deliverVerdictToMarketplace: async ({ operationId }) => {
          calls.push("marketplace-deliver");
          delivered = true;
          return { operationId, transaction: deliverTx };
        },
        readCanonicalVerdictDelivery: async () => delivered ? ({
          requestId,
          deliveryDigest: `0x${"0".repeat(64)}`,
          transaction: { ...deliverTx, logIndex: 2 },
        }) : undefined,
        claimVerdictDelivery: async ({ operationId }) => {
          calls.push("verdict-settlement");
          settled = true;
          return { operationId, status: "settled", transaction: settleTx };
        },
        readVerdictSettlement: async () => settled ? ({
          requestId,
          taskId: 7n,
          attemptIndex: 1,
          verdictIndex: 0,
          evaluator: evaluatorAddress,
          verdictCode: 1,
          verdictDigest: `0x${documentDigest(verdictBytes).slice(7)}`,
          transaction: { ...settleTx, logIndex: 3 },
        }) : undefined,
      },
      chain: {
        isFinalized: async () => true,
        transactionStatus: async () => ({ kind: "canonical" }),
      },
      deliverySignature: { get: () => new TextEncoder().encode("evaluation-delivery-envelope") },
      evidence: {
        awaitIndexed: async () => ({ status: "indexed" }),
        getRecord: async () => evidenceBytes,
      },
      publisher: {
        sourceId: "urn:jinn:source:evaluator-records",
        publish: async ({ artifact }) => {
          calls.push(`publish:${artifact.role}`);
          return { location: `https://evaluator.example/${artifact.digest}`, sequence: "1", entryDigest: artifact.digest };
        },
      },
      verification: {
        verify: async ({ canonical }) => {
          calls.push(canonical === undefined ? "verdict-gate" : "verdict-gate-finalized");
          return { ok: true, verdictCode: 1 };
        },
      },
    });

    await expect(coordinator.reconcileEvaluation(id)).resolves.toEqual({ kind: "verdict-settlement-pending" });
    await expect(coordinator.reconcileEvaluation(id)).resolves.toEqual({ kind: "complete" });
    expect(state.getEvaluation(id)).toMatchObject({ state: "complete", verdictCode: 1 });
    expect(calls).toEqual([
      "evaluation-claim",
      "backend-submit",
      "verdict-gate",
      "publish:verdict",
      "publish:evaluation-delivery",
      "publish:evaluation-delivery-envelope",
      "publish:evaluation-evidence",
      "verdict-gate",
      "marketplace-deliver",
      "verdict-gate",
      "verdict-settlement",
      "verdict-gate-finalized",
    ]);
    expect(state.listEvaluationOperations(id).map(({ kind, status }) => [kind, status])).toEqual([
      ["evaluation-claim", "finalized"],
      ["evaluation-backend-submit", "finalized"],
      ["evaluation-marketplace-delivery", "finalized"],
      ["verdict-settlement", "finalized"],
    ]);
  });

  it("never opens an evaluation claim when subject authority has not been verified", async () => {
    const { store, state, id } = setup();
    store.db.prepare("DELETE FROM native_evaluation_authority WHERE evaluation_id = ?").run(id);
    const opened = vi.fn();
    const coordinator = new NativeEvaluatorCoordinator({
      state,
      backend: {} as never,
      authority: {
        claim: async () => { throw new Error("trusted authority unavailable"); },
        dependencies: {} as never,
      },
      deadline: () => "2026-08-03T00:00:00Z",
      evaluatorAddress,
      verdictPorts: { openVerdictAttempt: opened } as never,
      chain: {} as never,
      deliverySignature: {} as never,
      evidence: {} as never,
      publisher: {} as never,
      verification: {} as never,
    });
    await expect(coordinator.reconcileEvaluation(id)).resolves.toEqual({
      kind: "paused",
      reason: "evaluator-dependency-failed",
    });
    expect(opened).not.toHaveBeenCalled();
  });
});

function DeliveryRecordForAttempt(
  attempt: string,
  taskDigest: `sha256:${string}`,
  verdictBytes: Uint8Array,
  evidenceBytes: Uint8Array,
): Uint8Array {
  return sealDelivery({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    attempt: attempt as `urn:uuid:${string}`,
    task: taskDigest,
    outputs: [{ name: "verdict", digest: { sha256: documentDigest(verdictBytes).slice(7) } }],
    evidenceRecords: [{ family: "execution-evidence", digest: documentDigest(evidenceBytes) }],
    outcome: "fulfilled",
    createdAt: "2026-08-02T11:30:00Z",
  });
}
