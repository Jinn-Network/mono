import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { documentDigest } from "@jinn-network/task-execution-protocol";
import { Store } from "../../src/store/store.js";
import {
  NativeEvaluatorStateRepository,
  NativeEvaluatorStateConflictError,
} from "../../src/daemon/native-evaluator-state.js";
import { NativeEvaluatorCoordinator } from "../../src/daemon/native-evaluator-coordinator.js";
import { NativeSubjectAuthorityError } from "../../src/evaluator/native-subject-authority.js";
import { buildNativeEvaluatorVerdictVerification } from "../../src/evaluator/native-verdict-verification.js";

/**
 * The exact subject graph, admission authority, sealed evaluation pair and delivered verdict
 * bytes of the DR-2026-08-05 gate's round 26 (2026-08-12, task 1234) -- the first live round whose
 * evaluation harness graded to completion. The captured verdict is the harness's own 2280-byte
 * DSSE envelope (`inconclusive`, `limitations: ["market-unresolved"]`), in its exact
 * pretty-printed `application/vnd.in-toto+json` spelling, so this drives the real bytes through
 * the production path rather than a compact re-spelling a unit fixture would produce.
 */
const fixture = JSON.parse(readFileSync(
  fileURLToPath(new URL("../fixtures/native-evaluator/round-26-verdict-ready.json", import.meta.url)),
  "utf8",
)) as Round26Fixture;

interface CapturedArtifact { readonly name: string; readonly digest: string; readonly bytes: string }
interface Round26Fixture {
  readonly opportunity: {
    readonly source: string; readonly sourceSequence: string; readonly sourceEntryDigest: string;
    readonly chainId: number; readonly coordinator: string; readonly taskId: string;
    readonly attemptIndex: number; readonly solutionRequestId: string; readonly operatorAddress: string;
    readonly advertisedDeliveryDigest: string; readonly blockHash: string; readonly blockNumber: string;
    readonly transactionHash: string; readonly logIndex: number; readonly canonicalEventIdentity: string;
    readonly evaluatorAgent: string;
  };
  readonly authority: Record<string, unknown>;
  readonly derived: {
    readonly taskDigest: string; readonly taskBytes: string;
    readonly submissionDigest: string; readonly submissionBytes: string; readonly submissionUri: string;
  };
  readonly claim: { readonly requestId: string; readonly verdictIndex: number };
  readonly subject: Record<string, CapturedArtifact>;
  readonly delivered: {
    readonly verdict: string; readonly delivery: string; readonly deliveryEnvelope: string;
    readonly evidence: string; readonly evidenceFamily: string; readonly evidenceDigest: string;
  };
}

const bytes = (value: string) => new Uint8Array(Buffer.from(value, "base64"));
const one = (role: string) => {
  const captured = fixture.subject[role]!;
  return { name: captured.name, digest: captured.digest as `sha256:${string}`, bytes: bytes(captured.bytes) };
};
const many = (prefix: string) => Object.entries(fixture.subject)
  .filter(([role]) => role.startsWith(`${prefix}:`))
  .map(([, captured]) => ({
    name: captured.name, digest: captured.digest as `sha256:${string}`, bytes: bytes(captured.bytes),
  }));

const material = {
  task: one("task"),
  submission: one("submission"),
  requesterEnvelope: one("requester-envelope"),
  admissionReceipt: one("admission-receipt"),
  delivery: one("solution-delivery"),
  deliveryEnvelope: one("solution-delivery-envelope"),
  evidenceRecords: many("solution-evidence"),
  results: many("solution-result"),
  evaluationSpec: one("evaluation-spec"),
};

const verdictBytes = bytes(fixture.delivered.verdict);
const deliveryBytes = bytes(fixture.delivered.delivery);
const deliveryEnvelopeBytes = bytes(fixture.delivered.deliveryEnvelope);
const evidenceBytes = bytes(fixture.delivered.evidence);
const evaluatorAddress = (fixture.authority as { evaluator: { address: string } }).evaluator
  .address as `0x${string}`;

function seed() {
  const store = new Store(":memory:");
  const state = new NativeEvaluatorStateRepository(store, { now: () => new Date("2026-08-12T22:42:29Z") });
  const admitted = state.admitOpportunity({
    opportunity: {
      source: fixture.opportunity.source,
      sourceSequence: fixture.opportunity.sourceSequence,
      sourceEntryDigest: fixture.opportunity.sourceEntryDigest as `sha256:${string}`,
      canonical: true,
      finality: "finalized",
      chainId: fixture.opportunity.chainId,
      taskId: BigInt(fixture.opportunity.taskId),
      attemptIndex: fixture.opportunity.attemptIndex,
      solutionRequestId: fixture.opportunity.solutionRequestId as `0x${string}`,
      operatorAddress: fixture.opportunity.operatorAddress as `0x${string}`,
      deliveryCid: "bafyround26",
      advertisedDeliveryDigest: fixture.opportunity.advertisedDeliveryDigest as `sha256:${string}`,
      blockHash: fixture.opportunity.blockHash as `0x${string}`,
      blockNumber: BigInt(fixture.opportunity.blockNumber),
      transactionHash: fixture.opportunity.transactionHash as `0x${string}`,
      logIndex: fixture.opportunity.logIndex,
      canonicalEventIdentity: fixture.opportunity.canonicalEventIdentity,
    },
    evaluatorAgent: fixture.opportunity.evaluatorAgent,
    coordinator: fixture.opportunity.coordinator,
    material,
  });
  state.recordAdmissionVerified(admitted.evaluationId, fixture.authority as never);
  state.recordDerivedEvaluation(admitted.evaluationId, {
    taskBytes: bytes(fixture.derived.taskBytes),
    taskDigest: fixture.derived.taskDigest as `sha256:${string}`,
    submissionBytes: bytes(fixture.derived.submissionBytes),
    submissionDigest: fixture.derived.submissionDigest as `sha256:${string}`,
    submissionUri: fixture.derived.submissionUri as `urn:uuid:${string}`,
  });
  return { store, state, id: admitted.evaluationId };
}

/**
 * The production verdict verification port, wired to ports that pass. The exact-graph half --
 * the strict DSSE parse of the delivered verdict, the `sealDelivery` canonicality re-check, the
 * output/evidence cardinality joins and the `decisionGradeVerdictCode` read -- is the real
 * implementation running against the real captured bytes.
 */
const verification = buildNativeEvaluatorVerdictVerification({
  gate: { gate: async () => ({ decisionGrade: true, failures: [] }) },
  solutionDeliveryAuthority: { verify: async () => ({ ok: true }) },
  evaluationDeliveryAuthority: { verify: async () => ({ ok: true }) },
  preSettlementClaimTime: async () => "2026-08-12T22:42:29.000Z",
  blockTime: async () => "2026-08-12T22:42:29.000Z",
});

function coordinatorFor(state: NativeEvaluatorStateRepository, input: {
  readonly observations: readonly { readonly terminal: boolean; readonly state: string }[];
}) {
  let observation = 0;
  let attemptOpened = false;
  const claimTx = { hash: `0x${"3".repeat(64)}`, blockNumber: 101n, blockHash: `0x${"4".repeat(64)}` };
  const published: string[] = [];
  const coordinator = new NativeEvaluatorCoordinator({
    state,
    backend: {
      // `matching`, not `present`: `ReconciliationReport.classification` is
      // `matching | absent | contradictory`, and only `absent` re-submits.
      recover: async () => ({ classification: observation === 0 ? "absent" : "matching" }),
      submit: async () => ({ accepted: true }),
      observe: async () => ({
        descriptor: {
          derived: input.observations[Math.min(observation++, input.observations.length - 1)]!,
        },
      }),
      deliveries: async () => [{ digest: documentDigest(deliveryBytes), uri: "memory:delivery" }],
      fetchDelivery: async () => deliveryBytes,
      fetchArtifact: async () => verdictBytes,
      capabilities: async () => ({}),
    } as never,
    authority: {
      claim: async () => { throw new Error("authority was already persisted"); },
      dependencies: {} as never,
    },
    deadline: () => "2026-08-13T00:00:00Z",
    evaluatorAddress,
    verdictPorts: {
      canOpenVerdictAttempt: async () => ({ ok: true }),
      openVerdictAttempt: async ({ operationId }) => {
        attemptOpened = true;
        return {
          operationId,
          requestId: fixture.claim.requestId as `0x${string}`,
          verdictIndex: fixture.claim.verdictIndex,
          transaction: claimTx,
        };
      },
      readCanonicalVerdictAttempt: async () => attemptOpened ? ({
        taskId: BigInt(fixture.opportunity.taskId),
        attemptIndex: fixture.opportunity.attemptIndex,
        verdictIndex: fixture.claim.verdictIndex,
        requestId: fixture.claim.requestId as `0x${string}`,
        evaluator: evaluatorAddress,
        transaction: { ...claimTx, logIndex: 1 },
      }) : undefined,
      // CP7 is out of scope here: the marketplace Deliver broadcasts and stays un-canonical, so the
      // drive stops at the verdict-delivery boundary with the verdict graph already durable.
      deliverVerdictToMarketplace: async ({ operationId }: { operationId: string }) => ({
        operationId,
        transaction: { hash: `0x${"6".repeat(64)}`, blockNumber: 102n, blockHash: `0x${"7".repeat(64)}` },
      }),
      readCanonicalVerdictDelivery: async () => undefined,
      claimVerdictDelivery: async () => { throw new Error("settlement is out of scope"); },
      readVerdictSettlement: async () => undefined,
    } as never,
    chain: { isFinalized: async () => true, transactionStatus: async () => ({ kind: "canonical" }) } as never,
    deliverySignature: { get: () => deliveryEnvelopeBytes },
    evidence: {
      awaitIndexed: async () => ({ status: "indexed" }),
      getRecord: async () => evidenceBytes,
    },
    publisher: {
      sourceId: "urn:jinn:source:evaluator-records",
      publish: async ({ artifact }: { artifact: { role: string; digest: string } }) => {
        published.push(artifact.role);
        return { location: `https://evaluator.example/${artifact.digest}`, sequence: "1", entryDigest: artifact.digest };
      },
    } as never,
    verification,
    retry: { delayMs: 5_000, maxDelayMs: 300_000 },
  });
  return { coordinator, published };
}

describe("native evaluator verdict-ready (defect #43)", () => {
  it("records the verdict graph when the backend attempt terminalizes on a later tick", async () => {
    const { state, id } = seed();
    // The captured graph reproduces the live evaluation identity exactly, so this fixture is the
    // round-26 evaluation and not a look-alike.
    expect(id).toBe("sha256:cca2625502c3a28c4948ba8a3a4294b0a7dfe893eff14e13c5b9664255f81b10");
    // Tick 1 observes a still-running attempt; tick 2 observes the delivered one. Every live
    // evaluation takes this shape -- a local harness needs ~1s and the coordinator ticks at 5s --
    // yet before this fix tick 2 re-entered `beginEvaluationExecution` in the `evaluating` state
    // and terminal-failed the evaluation into the opaque `evaluator-dependency-failed` bucket,
    // discarding a verdict that was already sealed, delivered and on disk.
    const { coordinator, published } = coordinatorFor(state, {
      observations: [{ terminal: false, state: "executing" }, { terminal: true, state: "delivered" }],
    });

    await expect(coordinator.reconcileEvaluation(id)).resolves.toEqual({ kind: "evaluating" });
    expect(state.getEvaluation(id)).toMatchObject({ state: "evaluating" });

    const advanced = await coordinator.reconcileEvaluation(id) as { kind: string; reason?: string };
    expect(advanced.kind).not.toBe("failed");
    expect(advanced.reason).toBeUndefined();

    // `inconclusive` is `VerdictCode.Unresolved` (4) -- read off the real delivered envelope by the
    // production `decisionGradeVerdictCode` path, not asserted from the fixture's own metadata.
    expect(state.getEvaluation(id)).toMatchObject({ verdictCode: 4 });
    const artifacts = state.listEvaluationArtifacts(id);
    expect(artifacts.map(({ role }) => role).sort()).toEqual([
      "evaluation-delivery",
      "evaluation-delivery-envelope",
      "evaluation-evidence",
      "evaluation-submission",
      "evaluation-task",
      "verdict",
    ]);
    const verdict = artifacts.find(({ role }) => role === "verdict")!;
    expect(verdict.digest).toBe("sha256:29a39e9c1752ceeb732129fe975e6646688f2804855a6f8eebbcda1350ce386f");
    expect(Buffer.from(verdict.bytes)).toEqual(Buffer.from(verdictBytes));
    expect(published).toContain("verdict");
  });

  it("re-enters an already-submitted backend attempt idempotently, and still refuses a changed Attempt", async () => {
    const { store, state, id } = seed();
    const { coordinator } = coordinatorFor(state, {
      observations: [{ terminal: false, state: "executing" }],
    });
    await expect(coordinator.reconcileEvaluation(id)).resolves.toEqual({ kind: "evaluating" });

    const first = state.beginEvaluationExecution(id);
    expect(state.beginEvaluationExecution(id)).toEqual(first);
    expect(state.listEvaluationOperations(id)
      .filter(({ kind }) => kind === "evaluation-backend-submit")).toHaveLength(1);

    // Fail-closed is preserved: the operation stays keyed to the finalized Attempt, so a state
    // whose Attempt identity moved underneath the submission is still a conflict, not a re-entry.
    store.db.prepare(
      "UPDATE native_evaluation_executions SET attempt_uri = ? WHERE evaluation_id = ?",
    ).run("urn:uuid:00000000-0000-4000-8000-0000000000ff", id);
    expect(() => state.beginEvaluationExecution(id)).toThrow(NativeEvaluatorStateConflictError);
  });

  it("refuses to begin a backend attempt before the claim is finalized", async () => {
    const { state, id } = seed();
    expect(state.getEvaluation(id)).toMatchObject({ state: "evaluation-pending" });
    expect(() => state.beginEvaluationExecution(id)).toThrow(NativeEvaluatorStateConflictError);
  });

  it("refuses to begin a backend attempt from a post-execution phase that already holds an Attempt", async () => {
    // The `evaluation-pending` case above is refused by the sealed-pair clause alone
    // (`attemptUri === null`), so it passes with the STATE clause deleted. This case pins the state
    // clause on its own: the Attempt is the real one minted by the finalized claim, and the phase
    // is one the coordinator must never re-enter through `execute()`.
    const { store, state, id } = seed();
    const { coordinator } = coordinatorFor(state, {
      observations: [{ terminal: false, state: "executing" }],
    });
    await expect(coordinator.reconcileEvaluation(id)).resolves.toEqual({ kind: "evaluating" });
    expect(state.getDerivedEvaluation(id)?.attemptUri).not.toBeNull();

    store.db.prepare("UPDATE native_evaluations SET state = 'verdict-ready' WHERE evaluation_id = ?").run(id);
    expect(() => state.beginEvaluationExecution(id)).toThrow(NativeEvaluatorStateConflictError);
  });

  it("names the throwing class, message and stack head on an unclassified terminal failure", async () => {
    const { store, state, id } = seed();
    const { coordinator } = coordinatorFor(state, {
      observations: [{ terminal: false, state: "executing" }],
    });
    await expect(coordinator.reconcileEvaluation(id)).resolves.toEqual({ kind: "evaluating" });

    // A `TypeError` is one of the two classes the coordinator terminalizes silently. Before this
    // fix both it and #43's state conflict produced the bare string `evaluator-dependency-failed`
    // in the audit row and in the daemon's `[evaluator] evaluation failed: …` warning, which is
    // what forced three separate defects to be diagnosed by replaying preserved state offline.
    store.db.prepare("DELETE FROM native_evaluation_executions WHERE evaluation_id = ?").run(id);
    const broken = coordinatorFor(state, { observations: [{ terminal: false, state: "executing" }] });
    Object.defineProperty(state, "getDerivedEvaluation", {
      value: () => { throw new TypeError("Cannot read properties of undefined (reading 'attemptUri')"); },
    });

    const result = await broken.coordinator.reconcileEvaluation(id) as { kind: string; reason: string };
    expect(result.kind).toBe("failed");
    expect(result.reason).not.toBe("evaluator-dependency-failed");
    expect(result.reason).toBe(
      "evaluator-dependency-failed: TypeError: Cannot read properties of undefined (reading 'attemptUri')",
    );

    const audit = store.db.prepare(
      "SELECT detail_json FROM native_evaluation_audit WHERE evaluation_id = ? AND kind = 'evaluation-failed-terminal'",
    ).get(id) as { detail_json: string };
    const detail = JSON.parse(audit.detail_json) as Record<string, string>;
    expect(detail.cause).toBe("TypeError: Cannot read properties of undefined (reading 'attemptUri')");
    expect(detail.causeStack).toMatch(/^at /u);
    expect(detail.causeStack.length).toBeLessThanOrEqual(400);
  });

  it("bounds the cause string of an unclassified terminal failure", async () => {
    const { store, state, id } = seed();
    const { coordinator } = coordinatorFor(state, {
      observations: [{ terminal: false, state: "executing" }],
    });
    await expect(coordinator.reconcileEvaluation(id)).resolves.toEqual({ kind: "evaluating" });

    // `${name}: ${message}` was unbounded while `causeStack` was sliced to 400: a schema-validation
    // message (a ZodError names every failing path) turned one audit row into a log dump.
    const broken = coordinatorFor(state, { observations: [{ terminal: false, state: "executing" }] });
    Object.defineProperty(state, "getDerivedEvaluation", {
      value: () => { throw new TypeError("x".repeat(5_000)); },
    });

    const result = await broken.coordinator.reconcileEvaluation(id) as { kind: string; reason: string };
    expect(result.kind).toBe("failed");
    const audit = store.db.prepare(
      "SELECT detail_json FROM native_evaluation_audit WHERE evaluation_id = ? AND kind = 'evaluation-failed-terminal'",
    ).get(id) as { detail_json: string };
    const detail = JSON.parse(audit.detail_json) as Record<string, string>;
    expect(detail.cause.length).toBeLessThanOrEqual(400);
    expect(detail.cause.startsWith("TypeError: xxx")).toBe(true);
  });

  it("carries the bounded cause detail on a refused subject authority", async () => {
    const { store, state, id } = seed();
    const broken = coordinatorFor(state, { observations: [{ terminal: false, state: "executing" }] });
    Object.defineProperty(state, "getAdmissionAuthority", {
      value: () => { throw new NativeSubjectAuthorityError("evaluator-not-safe-owner", "y".repeat(5_000)); },
    });

    const result = await broken.coordinator.reconcileEvaluation(id) as { kind: string; reason: string };
    expect(result.kind).toBe("failed");
    expect(result.reason.startsWith("native-subject-authority-refused: ")).toBe(true);
    const audit = store.db.prepare(
      "SELECT detail_json FROM native_evaluation_audit WHERE evaluation_id = ? AND kind = 'evaluation-failed-terminal'",
    ).get(id) as { detail_json: string };
    const detail = JSON.parse(audit.detail_json) as Record<string, string>;
    expect(detail.cause.length).toBeLessThanOrEqual(400);
    expect(detail.causeStack).toMatch(/^at /u);
  });
});

/**
 * A retraction pauses an admitted evaluation, and before this fix it wrote `paused` with NO retry
 * schedule — a shape `resumeEvaluationRetry` refused, so the very next tick terminal-failed the
 * evaluation with `evaluator-dependency-failed: NativeEvaluatorStateConflictError: paused
 * evaluation has no retry schedule`.
 *
 * The live trigger chain that makes this round-27 critical: an orphan misclassification of a mined
 * settlement makes the solver publish a signed WITHDRAWAL for a delivery that is in fact canonical;
 * the evaluator ingests it as `solution-withdrawn`, retracts, pauses without a schedule, and
 * discards an evaluation that was doing nothing wrong.
 */
describe("native evaluator retraction pause", () => {
  const retract = (state: NativeEvaluatorStateRepository, sequence: string) => state.retractOpportunity({
    source: fixture.opportunity.source,
    sourceSequence: sequence,
    sourceEntryDigest: `sha256:${"5".repeat(64)}`,
    canonicalEventIdentity: fixture.opportunity.canonicalEventIdentity,
    reason: "orphan-misclassified settlement withdrawal",
  });

  it("resumes an evaluation retracted while its backend attempt is running", async () => {
    const { state, id } = seed();
    const { coordinator } = coordinatorFor(state, {
      observations: [{ terminal: false, state: "executing" }],
    });
    await expect(coordinator.reconcileEvaluation(id)).resolves.toEqual({ kind: "evaluating" });

    retract(state, "0000000000000900");
    expect(state.getEvaluation(id)).toMatchObject({ state: "paused" });

    const result = await coordinator.reconcileEvaluation(id) as { kind: string; reason?: string };
    expect(String(result.reason)).not.toMatch(/paused evaluation has no retry schedule/u);
    expect(result.kind).not.toBe("failed");
    expect(state.getEvaluation(id)).toMatchObject({ state: "evaluating" });
  });

  it("resumes a retracted evaluation whose verdict graph is already durable", async () => {
    const { store, state, id } = seed();
    const { coordinator } = coordinatorFor(state, {
      observations: [{ terminal: false, state: "executing" }, { terminal: true, state: "delivered" }],
    });
    await coordinator.reconcileEvaluation(id);
    await coordinator.reconcileEvaluation(id);
    // Pinned at `verdict-ready` — the phase whose durable artifacts a paused-then-discarded
    // evaluation destroys.
    store.db.prepare("UPDATE native_evaluations SET state = 'verdict-ready' WHERE evaluation_id = ?").run(id);

    retract(state, "0000000000000901");
    expect(state.getEvaluation(id)).toMatchObject({ state: "paused" });

    const result = await coordinator.reconcileEvaluation(id) as { kind: string; reason?: string };
    expect(result.kind).not.toBe("failed");
    expect(state.getEvaluation(id)?.state).not.toBe("failed");
    // The verdict graph survives the retraction untouched.
    expect(state.listEvaluationArtifacts(id).map(({ role }) => role)).toContain("verdict");
  });

  it("leaves a settled evaluation complete when a withdrawal arrives late", async () => {
    const { store, state, id } = seed();
    const { coordinator } = coordinatorFor(state, {
      observations: [{ terminal: false, state: "executing" }, { terminal: true, state: "delivered" }],
    });
    await coordinator.reconcileEvaluation(id);
    await coordinator.reconcileEvaluation(id);
    store.db.prepare("UPDATE native_evaluations SET state = 'complete' WHERE evaluation_id = ?").run(id);

    retract(state, "0000000000000902");

    expect(state.getEvaluation(id)).toMatchObject({ state: "complete" });
    expect(state.sourceCheckpoint(fixture.opportunity.source)).toEqual({
      sequence: "0000000000000902",
      entryDigest: `sha256:${"5".repeat(64)}`,
    });
    const audit = store.db.prepare(
      "SELECT detail_json FROM native_evaluation_audit WHERE evaluation_id = ? AND kind = 'evaluation-retraction-ignored'",
    ).get(id) as { detail_json: string } | undefined;
    expect(JSON.parse(audit!.detail_json)).toMatchObject({ state: "complete" });
    await expect(coordinator.reconcileEvaluation(id)).resolves.toEqual({ kind: "complete" });
  });
});
