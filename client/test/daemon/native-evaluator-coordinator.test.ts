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
import { NativeSubjectAuthorityError } from "../../src/evaluator/native-subject-authority.js";

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
    let submittedTask = new Uint8Array();
    let submittedSubmission = new Uint8Array();
    const published = new Map<string, Uint8Array>();

    const coordinator = new NativeEvaluatorCoordinator({
      state,
      backend: {
        recover: async () => ({ classification: "absent" }),
        submit: async (task, submission, engagement) => {
          calls.push("backend-submit");
          submittedTask = Uint8Array.from(task);
          submittedSubmission = Uint8Array.from(submission);
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
          published.set(artifact.role, Uint8Array.from(artifact.bytes));
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
    expect(published.get("evaluation-task")).toEqual(submittedTask);
    expect(published.get("evaluation-submission")).toEqual(submittedSubmission);
    expect(calls).toEqual([
      "evaluation-claim",
      "backend-submit",
      "verdict-gate",
      "publish:evaluation-task",
      "publish:evaluation-submission",
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

  it("bounds durable evaluator dependency retries by next-at, attempt budget, and deadline", async () => {
    const { store, state, id } = setup();
    store.db.prepare("DELETE FROM native_evaluation_authority WHERE evaluation_id = ?").run(id);
    const opened = vi.fn();
    const authority = vi.fn(async () => { throw new Error("trusted authority unavailable"); });
    let nowMs = Date.parse("2026-08-02T12:00:00Z");
    const coordinator = new NativeEvaluatorCoordinator({
      state,
      backend: {} as never,
      authority: {
        claim: authority,
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
      retry: {
        now: () => new Date(nowMs),
        delayMs: 1_000,
        maxAttempts: 2,
      },
    });
    await expect(coordinator.reconcileEvaluation(id)).resolves.toEqual({
      kind: "paused",
      reason: "evaluator-dependency-failed",
    });
    expect(authority).toHaveBeenCalledOnce();
    await expect(coordinator.reconcileEvaluation(id)).resolves.toEqual({
      kind: "paused",
      reason: "retry-not-due",
    });
    expect(authority).toHaveBeenCalledOnce();
    nowMs += 1_001;
    await expect(coordinator.reconcileEvaluation(id)).resolves.toEqual({
      kind: "paused",
      reason: "evaluator-dependency-failed",
    });
    nowMs += 1_001;
    await expect(coordinator.reconcileEvaluation(id)).resolves.toEqual({
      kind: "failed",
      reason: "evaluator-retry-exhausted",
    });
    expect(authority).toHaveBeenCalledTimes(3);
    expect(state.getEvaluation(id)).toMatchObject({ state: "failed" });
    expect(opened).not.toHaveBeenCalled();
  });

  it("retries transient evaluator-dependency lag to the deadline rather than a fixed cumulative budget", async () => {
    const { store, state, id } = setup();
    store.db.prepare("DELETE FROM native_evaluation_authority WHERE evaluation_id = ?").run(id);
    const authority = vi.fn(async () => { throw new Error("trusted authority unavailable"); });
    let nowMs = Date.parse("2026-08-02T12:00:00Z");
    const coordinator = new NativeEvaluatorCoordinator({
      state,
      backend: {} as never,
      authority: { claim: authority, dependencies: {} as never },
      deadline: () => "2026-08-03T00:00:00Z",
      evaluatorAddress,
      verdictPorts: {} as never,
      chain: {} as never,
      deliverySignature: {} as never,
      evidence: {} as never,
      publisher: {} as never,
      verification: {} as never,
      // Composition default: no `maxAttempts`, so the deadline is the sole cap. The old `?? 5`
      // terminal-failed on the 6th cumulative lag even though nothing about the evaluation failed.
      retry: { now: () => new Date(nowMs), delayMs: 1_000 },
    });
    await expect(coordinator.reconcileEvaluation(id)).resolves.toEqual({
      kind: "paused",
      reason: "evaluator-dependency-failed",
    });
    for (let attempt = 2; attempt <= 8; attempt++) {
      nowMs += 1_001;
      await expect(coordinator.reconcileEvaluation(id)).resolves.toEqual({
        kind: "paused",
        reason: "evaluator-dependency-failed",
      });
    }
    expect(state.getEvaluation(id)).toMatchObject({ state: "paused" });
    expect(state.getEvaluationRetryCount(id)).toBe(8);
  });

  it("resets the retry counter when a paused evaluation advances to a later phase", async () => {
    const { store, state, id } = setup();
    // Two lags recorded against the claim phase.
    for (let attempt = 1; attempt <= 2; attempt++) {
      state.recordEvaluationPaused(id, {
        reason: "evaluation-evidence-not-indexed",
        nextAttemptAt: "2026-08-02T12:00:05Z",
        deadline: "2026-08-03T00:00:00Z",
      });
    }
    expect(state.getEvaluationRetryCount(id)).toBe(2);

    // A successful drive that leaves the evaluation in a new phase clears the schedule.
    store.db.prepare("UPDATE native_evaluations SET state = 'evaluating' WHERE evaluation_id = ?").run(id);
    expect(state.resetEvaluationRetryOnAdvance(id)).toBe(true);
    expect(state.getEvaluationRetryCount(id)).toBe(0);

    // A fresh lag in the new phase starts its own budget from one, not from three.
    state.recordEvaluationPaused(id, {
      reason: "evaluation-delivery-envelope-missing",
      nextAttemptAt: "2026-08-02T12:00:05Z",
      deadline: "2026-08-03T00:00:00Z",
    });
    expect(state.getEvaluationRetryCount(id)).toBe(1);
  });

  it("fails fast and surfaces the reason on a deterministic subject-authority refusal instead of retrying to the SLA", async () => {
    const { store, state, id } = setup();
    store.db.prepare("DELETE FROM native_evaluation_authority WHERE evaluation_id = ?").run(id);
    const opened = vi.fn();
    // The cross-operator settlement-authority refusal shape from the live two-operator gate (#33):
    // a `NativeSubjectAuthorityError` propagating out of the prepareClaim authority step.
    const authority = vi.fn(async () => {
      throw new NativeSubjectAuthorityError(
        "executor-settlement-binding-failed",
        "settlement authority did:key:solver Safe 0xc679 does not own ceremony signer 0xB35f",
      );
    });
    const coordinator = new NativeEvaluatorCoordinator({
      state,
      backend: {} as never,
      authority: { claim: authority, dependencies: {} as never },
      deadline: () => "2026-08-03T00:00:00Z",
      evaluatorAddress,
      verdictPorts: { openVerdictAttempt: opened } as never,
      chain: {} as never,
      deliverySignature: {} as never,
      evidence: {} as never,
      publisher: {} as never,
      verification: {} as never,
      // A retry schedule identical to production's: if the refusal were (wrongly) treated as a
      // transient dependency it would pause-and-retry here, not fail.
      retry: { now: () => new Date("2026-08-02T12:00:00Z"), delayMs: 5_000, maxDelayMs: 300_000 },
    });

    // Terminal on the FIRST attempt — never paused, never retried to the deadline.
    const result = await coordinator.reconcileEvaluation(id);
    expect(result.kind).toBe("failed");
    // The real cause is surfaced (specific sub-reason + detail), not the opaque dependency bucket.
    expect(result).toMatchObject({
      kind: "failed",
      reason: expect.stringContaining("executor-settlement-binding-failed"),
    });
    expect((result as { reason: string }).reason).toContain("does not own ceremony signer");
    expect((result as { reason: string }).reason).not.toBe("evaluator-dependency-failed");
    expect(authority).toHaveBeenCalledOnce();
    expect(state.getEvaluation(id)).toMatchObject({ state: "failed" });
    expect(opened).not.toHaveBeenCalled();
    // The durable terminal-failure audit carries the exact reason, so no DB spelunking is needed.
    const audit = store.db
      .prepare(
        "SELECT detail_json FROM native_evaluation_audit WHERE evaluation_id = ? AND kind = 'evaluation-failed-terminal'",
      )
      .get(id) as { detail_json: string } | undefined;
    expect(audit?.detail_json ?? "").toContain("executor-settlement-binding-failed");
  });

  /**
   * #36. The evaluator backend refused evidence capture deterministically and appended a terminal
   * carrying blame/category/detail. The derived projection keeps only `state`, and the coordinator
   * recorded only the failure CODE — so the sentence naming the actual refusal reached neither the
   * audit row nor the daemon log, and had to be recovered from the attempt journal on disk.
   */
  it("surfaces a backend terminal's own blame, category, and detail into the failure reason (#36)", async () => {
    const { store, state, id } = setup();
    const claimTx = { hash: `0x${"3".repeat(64)}`, blockNumber: 101n, blockHash: `0x${"4".repeat(64)}` };
    const detail = "evidence capture start failed: Graph identity urn:uuid:44cfb891 "
      + "is reused for incompatible contextual roles.";
    let attemptOpened = false;
    const coordinator = new NativeEvaluatorCoordinator({
      state,
      backend: {
        recover: async () => ({ classification: "absent" }),
        submit: async () => ({ accepted: true }) as never,
        observe: async () => ({
          descriptor: { derived: { terminal: true, state: "failed" } },
          observations: [{
            type: "network.jinn.task-execution.attempt-terminal.v1",
            sequence: "0000000000000002",
            data: {
              state: "failed",
              blame: "infrastructure",
              category: "dependency-unavailable",
              detail,
            },
          }],
        }) as never,
      } as never,
      authority: { claim: async () => { throw new Error("authority was already persisted"); }, dependencies: {} as never },
      deadline: () => "2026-08-03T00:00:00Z",
      evaluatorAddress,
      verdictPorts: {
        canOpenVerdictAttempt: async () => ({ ok: true }),
        openVerdictAttempt: async ({ operationId }: { operationId: string }) => {
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
      } as never,
      chain: { isFinalized: async () => true, transactionStatus: async () => ({ kind: "canonical" }) },
      deliverySignature: {} as never,
      evidence: {} as never,
      publisher: {} as never,
      verification: {} as never,
      retry: { now: () => new Date("2026-08-02T12:00:00Z"), delayMs: 5_000 },
    });

    const result = await coordinator.reconcileEvaluation(id);
    const reason = (result as { reason: string }).reason;
    expect(reason).toContain("evaluation-backend-terminal");
    expect(reason).toContain("blame=infrastructure");
    expect(reason).toContain("category=dependency-unavailable");
    expect(reason).toContain("reused for incompatible contextual roles");
    // The daemon's own log line (EvaluatorLoop) and the durable audit both read this one string.
    const audit = store.db
      .prepare(
        "SELECT detail_json FROM native_evaluation_audit WHERE evaluation_id = ? AND kind IN ('evaluation-failed-terminal', 'evaluation-paused')",
      )
      .get(id) as { detail_json: string } | undefined;
    expect(audit?.detail_json ?? "").toContain("reused for incompatible contextual roles");
  });

  it("retries (never terminalizes) a TRANSIENT subject-authority read failure, surfacing its reason", async () => {
    const { store, state, id } = setup();
    store.db.prepare("DELETE FROM native_evaluation_authority WHERE evaluation_id = ?").run(id);
    const opened = vi.fn();
    // A `Safe.isOwner` chain read that could not COMPLETE surfaces as a `NativeSubjectAuthorityError`
    // with `transient: true`. Unlike a refusal it may succeed on retry, so it must NOT be terminalized
    // to the SLA — it flows into the ordinary retry path, but with its exact reason (not the opaque
    // `evaluator-dependency-failed` bucket).
    const authority = vi.fn(async () => {
      throw new NativeSubjectAuthorityError(
        "executor-settlement-binding-failed",
        "settlement authority did:key:solver Safe-ownership read for 0xc679 failed: HTTP 503",
        { transient: true },
      );
    });
    const coordinator = new NativeEvaluatorCoordinator({
      state,
      backend: {} as never,
      authority: { claim: authority, dependencies: {} as never },
      deadline: () => "2026-08-03T00:00:00Z",
      evaluatorAddress,
      verdictPorts: { openVerdictAttempt: opened } as never,
      chain: {} as never,
      deliverySignature: {} as never,
      evidence: {} as never,
      publisher: {} as never,
      verification: {} as never,
      retry: { now: () => new Date("2026-08-02T12:00:00Z"), delayMs: 5_000, maxDelayMs: 300_000 },
    });

    const result = await coordinator.reconcileEvaluation(id);
    // Paused (retryable) — NOT terminal-failed. A transient read never buries a maybe-valid subject.
    expect(result.kind).toBe("paused");
    expect((result as { reason: string }).reason).toContain("native-subject-authority-unavailable");
    expect((result as { reason: string }).reason).toContain("Safe-ownership read");
    // Never the opaque bucket — the reason is recoverable without DB spelunking.
    expect((result as { reason: string }).reason).not.toBe("evaluator-dependency-failed");
    expect(state.getEvaluation(id)).toMatchObject({ state: "paused" });
    expect(opened).not.toHaveBeenCalled();
    // The durable retry/pause audit carries the exact transient reason.
    const audit = store.db
      .prepare(
        "SELECT detail_json FROM native_evaluation_audit WHERE evaluation_id = ? AND kind = 'evaluation-paused'",
      )
      .get(id) as { detail_json: string } | undefined;
    expect(audit?.detail_json ?? "").toContain("native-subject-authority-unavailable");
  });

  it("never opens an evaluation claim without persisted verified subject authority", async () => {
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
      retry: { now: () => new Date("2026-08-02T12:00:00Z") },
    });
    await expect(coordinator.reconcileEvaluation(id)).resolves.toMatchObject({ kind: "paused" });
    expect(opened).not.toHaveBeenCalled();
  });

  /**
   * Round 26 (CP6 live gate): the multi-provider RPC fallback chain served `finalized` heads that
   * disagreed by 130-500 blocks between consecutive polls, and a transaction that was mined,
   * successful, and finalized read as absent to whichever slot answered. The infrastructure
   * classifier used to call that `orphaned`, and this leg's `recordEvaluationOperationOrphaned`
   * NULLs `evaluation_attempt_uri` / `evaluation_request_id` and rolls the aggregate back — a
   * destructive rollback driven by nothing but provider lag.
   */
  function claimLegSetup(options: {
    readonly status: () => { readonly kind: "pending" } | { readonly kind: "orphaned"; readonly reason: string };
    readonly now?: string;
  }) {
    const { state, id } = setup();
    const claimTx = { hash: `0x${"3".repeat(64)}`, blockNumber: 101n, blockHash: `0x${"4".repeat(64)}` };
    const opened = vi.fn(async ({ operationId }: { operationId: string }) =>
      ({ operationId, requestId, verdictIndex: 0, transaction: claimTx }));
    const coordinator = new NativeEvaluatorCoordinator({
      state,
      backend: {} as never,
      authority: { claim: async () => { throw new Error("authority already persisted"); }, dependencies: {} as never },
      deadline: () => "2026-08-03T00:00:00Z",
      evaluatorAddress,
      verdictPorts: {
        canOpenVerdictAttempt: async () => ({ ok: true }),
        openVerdictAttempt: opened,
        // The polled slot never shows the claim — exactly what a lagging replica returns.
        readCanonicalVerdictAttempt: async () => undefined,
      } as never,
      chain: { isFinalized: async () => true, transactionStatus: async () => options.status() },
      deliverySignature: {} as never,
      evidence: {} as never,
      publisher: {} as never,
      verification: {} as never,
      retry: { now: () => new Date(options.now ?? "2026-08-02T12:00:00Z") },
    });
    return { state, id, coordinator, opened, claimTx };
  }

  it("holds a broadcast claim the chain has not confirmed instead of orphaning and re-broadcasting it", async () => {
    const { state, id, coordinator, opened, claimTx } = claimLegSetup({ status: () => ({ kind: "pending" }) });
    await expect(coordinator.reconcileEvaluation(id)).resolves.toEqual({ kind: "evaluation-claim-pending" });
    await expect(coordinator.reconcileEvaluation(id)).resolves.toEqual({ kind: "evaluation-claim-pending" });
    await expect(coordinator.reconcileEvaluation(id)).resolves.toEqual({ kind: "evaluation-claim-pending" });
    // One broadcast, not one per tick: the operation kept its transaction identity rather than
    // being rolled back to intent and re-opened.
    expect(opened).toHaveBeenCalledTimes(1);
    expect(state.listEvaluationOperations(id).map(({ kind, status, txHash }) => [kind, status, txHash]))
      .toEqual([["evaluation-claim", "broadcast", claimTx.hash]]);
    expect(state.getEvaluation(id)).toMatchObject({ state: "evaluation-claim-pending" });
  });

  it("still rolls a claim back when the chain gives positive evidence of a reorg", async () => {
    const { state, id, coordinator, opened } = claimLegSetup({
      status: () => ({ kind: "orphaned", reason: "transaction receipt is reverted or non-canonical" }),
    });
    await expect(coordinator.reconcileEvaluation(id)).resolves.toEqual({ kind: "evaluation-claim-pending" });
    await expect(coordinator.reconcileEvaluation(id)).resolves.toEqual({ kind: "evaluation-claim-pending" });
    expect(state.listEvaluationOperations(id).map(({ kind, status }) => [kind, status]))
      .toEqual([["evaluation-claim", "orphaned"]]);
    expect(state.getEvaluation(id)).toMatchObject({ state: "evaluation-pending" });
    // The rollback is the point: the next tick re-opens the claim.
    await expect(coordinator.reconcileEvaluation(id)).resolves.toEqual({ kind: "evaluation-claim-pending" });
    expect(opened).toHaveBeenCalledTimes(2);
  });

  it("terminalizes an unconfirmed claim on the admission deadline, not on provider lag", async () => {
    const { state, id, coordinator } = claimLegSetup({ status: () => ({ kind: "pending" }) });
    await expect(coordinator.reconcileEvaluation(id)).resolves.toEqual({ kind: "evaluation-claim-pending" });
    const { state: _state, id: lateId, coordinator: late } = claimLegSetup({
      status: () => ({ kind: "pending" }),
      // Past the 2026-08-03T00:00:00Z admission deadline the coordinator is handed.
      now: "2026-08-03T01:00:00Z",
    });
    // First tick broadcasts the claim; the second finds the chain still silent past the deadline.
    await expect(late.reconcileEvaluation(lateId)).resolves.toEqual({ kind: "evaluation-claim-pending" });
    // The retry schedule's own next attempt lies beyond the deadline, so the pause terminalizes
    // immediately rather than parking the evaluation for another provider poll.
    await expect(late.reconcileEvaluation(lateId)).resolves.toEqual({
      kind: "failed",
      reason: "evaluator-retry-exhausted",
    });
    expect(_state.getEvaluation(lateId)).toMatchObject({ state: "failed" });
    // The pre-deadline evaluation is untouched — lag alone never terminalizes.
    expect(state.getEvaluation(id)).toMatchObject({ state: "evaluation-claim-pending" });
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
