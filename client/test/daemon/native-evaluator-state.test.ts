import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Store } from "../../src/store/store.js";
import { NativeOperatorStateRepository } from "../../src/daemon/native-operator-state.js";
import {
  NativeEvaluatorStateConflictError,
  NativeEvaluatorStateRepository,
} from "../../src/daemon/native-evaluator-state.js";
import { evaluationId } from "../../src/daemon/native-operation-identity.js";

const digest = (bytes: Uint8Array) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const;
const artifact = (name: string, value: string) => {
  const bytes = new TextEncoder().encode(value);
  return { name, bytes, digest: digest(bytes) };
};

const material = {
  task: artifact("task", "task"),
  submission: artifact("submission", "submission"),
  requesterEnvelope: artifact("requester-envelope", "requester-envelope"),
  admissionReceipt: artifact("admission-receipt", "receipt"),
  delivery: artifact("delivery", "delivery"),
  deliveryEnvelope: artifact("delivery-envelope", "delivery-envelope"),
  evidenceRecords: [artifact("evidence:execution-evidence:0", "evidence")],
  results: [artifact("prediction", "prediction")],
  evaluationSpec: artifact("evaluation-spec", "evaluation-spec"),
};
const opportunity = {
  source: "https://solver.example/.well-known/jinn-source",
  sourceSequence: "0000000000000042",
  sourceEntryDigest: `sha256:${"a".repeat(64)}` as const,
  canonical: true as const,
  finality: "finalized" as const,
  chainId: 84532,
  taskId: 7n,
  attemptIndex: 1,
  solutionRequestId: `0x${"b".repeat(64)}` as const,
  operatorAddress: `0x${"c".repeat(40)}`,
  deliveryCid: "bafk-solution",
  advertisedDeliveryDigest: material.delivery.digest,
  blockHash: `0x${"d".repeat(64)}` as const,
  transactionHash: `0x${"e".repeat(64)}` as const,
  logIndex: 3,
  canonicalEventIdentity: `84532:0x${"d".repeat(64)}:3`,
};

describe("NativeEvaluatorStateRepository", () => {
  it("migrates an on-disk v2 operator DB to v3 without changing solver state", () => {
    const root = mkdtempSync(join(tmpdir(), "native-evaluator-v2-v3-"));
    const path = join(root, "operator.sqlite");
    try {
      const before = new Store(path);
      new NativeOperatorStateRepository(before);
      before.db.prepare(
        `INSERT INTO native_engagements
          (engagement_id, chain_id, coordinator, task_id, role, operator_agent, task_digest,
           submission_uri, submission_digest, state, policy_json, capability_json, created_at, updated_at)
         VALUES (?, '84532', ?, '7', 'solver', 'urn:jinn:solver:stable', ?, ?, ?,
           'solution-settled', '{}', '{}', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')`,
      ).run(
        `sha256:${"1".repeat(64)}`,
        `0x${"2".repeat(40)}`,
        `sha256:${"3".repeat(64)}`,
        "urn:uuid:40000000-0000-4000-8000-000000000004",
        `sha256:${"4".repeat(64)}`,
      );
      before.db.prepare("UPDATE native_operator_state_metadata SET schema_version = 2 WHERE singleton = 1").run();
      const preserved = before.db.prepare("SELECT * FROM native_engagements").get();
      before.close();

      const after = new Store(path);
      const evaluator = new NativeEvaluatorStateRepository(after);
      expect(evaluator.schemaVersion()).toBe(3);
      expect(after.db.prepare("SELECT * FROM native_engagements").get()).toEqual(preserved);
      expect(after.db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'native_evaluations'",
      ).get()).toEqual({ name: "native_evaluations" });
      after.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("atomically advances the source cursor with one exact durable evaluation aggregate", () => {
    const store = new Store(":memory:");
    const state = new NativeEvaluatorStateRepository(store, {
      now: () => new Date("2026-08-02T00:00:00.000Z"),
    });
    const admitted = state.admitOpportunity({
      opportunity,
      evaluatorAgent: "urn:jinn:evaluator:golden",
      coordinator: `0x${"f".repeat(40)}`,
      material,
    });
    expect(admitted).toEqual({
      kind: "admitted",
      evaluationId: evaluationId({
        subjectTaskDigest: material.task.digest,
        subjectDeliveryDigest: material.delivery.digest,
        evaluatorAgent: "urn:jinn:evaluator:golden",
      }),
    });
    expect(state.getEvaluation(admitted.evaluationId)).toMatchObject({
      state: "evaluation-pending",
      canonicalEventIdentity: opportunity.canonicalEventIdentity,
      advertisedDeliveryDigest: material.delivery.digest,
    });
    expect(state.sourceCheckpoint(opportunity.source)).toEqual({
      sequence: opportunity.sourceSequence,
      entryDigest: opportunity.sourceEntryDigest,
    });
    expect(state.listSubjectArtifacts(admitted.evaluationId)).toHaveLength(9);
  });

  it("deduplicates exact replay and rejects changed exact subject facts", () => {
    const state = new NativeEvaluatorStateRepository(new Store(":memory:"));
    const input = {
      opportunity,
      evaluatorAgent: "urn:jinn:evaluator:golden",
      coordinator: `0x${"f".repeat(40)}`,
      material,
    };
    const first = state.admitOpportunity(input);
    expect(state.admitOpportunity(input)).toEqual({ kind: "duplicate", evaluationId: first.evaluationId });
    expect(() => state.admitOpportunity({
      ...input,
      material: { ...material, requesterEnvelope: artifact("requester-envelope", "changed") },
    })).toThrow(NativeEvaluatorStateConflictError);
  });

  it("appends a canonical retraction and withdraws work before evaluation claim finality", () => {
    const state = new NativeEvaluatorStateRepository(new Store(":memory:"));
    const admitted = state.admitOpportunity({
      opportunity,
      evaluatorAgent: "urn:jinn:evaluator:golden",
      coordinator: `0x${"f".repeat(40)}`,
      material,
    });
    state.retractOpportunity({
      source: opportunity.source,
      sourceSequence: "0000000000000043",
      sourceEntryDigest: `sha256:${"9".repeat(64)}`,
      canonicalEventIdentity: opportunity.canonicalEventIdentity,
      reason: "safe-chain-reorg",
    });
    expect(state.getEvaluation(admitted.evaluationId)).toMatchObject({ state: "withdrawn" });
    expect(state.sourceCheckpoint(opportunity.source)).toEqual({
      sequence: "0000000000000043",
      entryDigest: `sha256:${"9".repeat(64)}`,
    });
    const replacement = state.admitOpportunity({
      opportunity: {
        ...opportunity,
        sourceSequence: "0000000000000044",
        sourceEntryDigest: `sha256:${"8".repeat(64)}`,
        blockHash: `0x${"7".repeat(64)}`,
        transactionHash: `0x${"6".repeat(64)}`,
        canonicalEventIdentity: `84532:0x${"7".repeat(64)}:3`,
      },
      evaluatorAgent: "urn:jinn:evaluator:golden",
      coordinator: `0x${"f".repeat(40)}`,
      material,
      reopenWithdrawn: true,
    });
    expect(replacement).toEqual({ kind: "reopened", evaluationId: admitted.evaluationId });
    expect(state.getEvaluation(admitted.evaluationId)).toMatchObject({
      state: "evaluation-pending",
      canonicalEventIdentity: `84532:0x${"7".repeat(64)}:3`,
    });
  });

  it("persists distinct evaluation claim, backend, publication, Deliver, and verdict settlement operations", () => {
    const state = new NativeEvaluatorStateRepository(new Store(":memory:"));
    const admitted = state.admitOpportunity({
      opportunity,
      evaluatorAgent: "urn:jinn:evaluator:golden",
      coordinator: `0x${"f".repeat(40)}`,
      material,
    });
    const taskBytes = new TextEncoder().encode("evaluation-task");
    const submissionBytes = new TextEncoder().encode("evaluation-submission");
    const attemptUri = "urn:uuid:30000000-0000-4000-8000-000000000003" as const;
    state.recordDerivedEvaluation(admitted.evaluationId, {
      taskBytes,
      taskDigest: digest(taskBytes),
      submissionBytes,
      submissionDigest: digest(submissionBytes),
      submissionUri: attemptUri,
    });
    const claim = state.beginEvaluationClaim(admitted.evaluationId, `0x${"1".repeat(64)}`);
    state.recordOperationBroadcast(claim.operationId, `0x${"2".repeat(64)}`);
    state.recordOperationReplacement(
      claim.operationId,
      `0x${"2".repeat(64)}`,
      `0x${"3".repeat(64)}`,
    );
    state.recordEvaluationClaimFinalized(claim.operationId, {
      txHash: `0x${"3".repeat(64)}`,
      blockHash: `0x${"4".repeat(64)}`,
      blockNumber: 100n,
      requestId: `0x${"5".repeat(64)}`,
      verdictIndex: 0,
      evaluatorAddress: `0x${"6".repeat(40)}`,
    });
    expect(state.getEvaluation(admitted.evaluationId)).toMatchObject({ state: "evaluation-finalized" });

    const backend = state.beginEvaluationExecution(admitted.evaluationId);
    state.recordEvaluationBackendAccepted(backend.operationId);
    expect(state.getEvaluation(admitted.evaluationId)).toMatchObject({ state: "evaluating" });

    const verdict = artifact("verdict", "verdict-envelope");
    const delivery = artifact("evaluation-delivery", "evaluation-delivery");
    state.recordVerdictReady(admitted.evaluationId, {
      sourceId: "urn:jinn:source:evaluator-records",
      verdictCode: 1,
      artifacts: [
        { role: "verdict", ...verdict },
        { role: "evaluation-delivery", ...delivery },
      ],
    });
    expect(state.listPendingEvaluationPublications()).toHaveLength(2);
    for (const publication of state.listPendingEvaluationPublications()) {
      state.recordEvaluationPublicationPublished(publication.publicationKey, { sequence: "1" });
    }
    expect(state.getEvaluation(admitted.evaluationId)).toMatchObject({ state: "verdict-published" });
    const deliver = state.beginEvaluationMarketplaceDelivery(admitted.evaluationId);
    const settlement = state.beginVerdictSettlement(admitted.evaluationId);
    expect(state.listEvaluationOperations(admitted.evaluationId).map(({ kind }) => kind)).toEqual([
      "evaluation-claim",
      "evaluation-backend-submit",
      "evaluation-marketplace-delivery",
      "verdict-settlement",
    ]);
    expect(deliver.operationId).not.toBe(settlement.operationId);
  });
});
