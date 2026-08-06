import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseMatrix } from "@jinn-network/benchmarking-records";
import type { AttemptUri, DeliveryRef, ObservationSnapshot, SubmissionAck, SubmissionUri } from "@jinn-network/task-execution-backend";
import type { ResourceDescriptor } from "@jinn-network/task-execution-protocol";
import { VERDICT_DSSE_PAYLOAD_TYPE } from "@jinn-network/task-execution-profiles";
import { sealDsseEnvelope } from "@jinn-network/trust-core";
import { atomicWriteFileSync } from "../fs/atomic.js";
import type { ProxiedBackend } from "../run/drive.js";
import { readRunJournalEntries } from "../run/journal.js";
import { readRunState, writeRunState } from "../run/state.js";
import { runJournalPath } from "../workspace/layout.js";
import { getSealedBytes, sha256Hex } from "../workspace/sealed-store.js";
import type { LocalVenue } from "../venue/venue.js";
import { armAdd } from "./arms.js";
import type { OperationContext } from "./context.js";
import { createDraft, readDraftDocument } from "./drafts.js";
import { initWorkspace } from "./init.js";
import { runCollect } from "./run-collect.js";
import { runLaunch } from "./run-launch.js";
import { runLock } from "./run-lock.js";
import { runQuote } from "./run-quote.js";
import { sampleInit } from "./sample.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bp12-run-collect-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

function makeClock(): () => string {
  let ms = Date.parse("2026-08-05T00:00:00.000Z");
  return () => {
    const value = new Date(ms).toISOString();
    ms += 10;
    return value;
  };
}

function contextFor(clock: () => string, principal = "sponsor-1"): OperationContext {
  return { workspaceDir, principal, clock };
}

function utf8(json: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(json));
}

/** A real DSSE-wrapped Result Evaluation Statement — `readVerdictEnvelope` (signing.ts) requires
 * an actual envelope shape, not arbitrary bytes; the signature itself is never verified by it. */
function buildVerdictEnvelope(input: { evaluatorId: string; evaluationSpecificationSha256: string }): Uint8Array {
  const statement = {
    predicateType: "https://spec.jinn.network/attestations/result-evaluation/v1",
    predicate: {
      evaluator: { id: input.evaluatorId },
      verdict: "pass",
      evaluationSpecification: { digest: { sha256: input.evaluationSpecificationSha256 } },
      measurements: [
        { name: "integrity", value: true },
        { name: "resolved", value: true },
      ],
      evaluatedAt: "2026-01-01T00:00:00Z",
    },
  };
  return sealDsseEnvelope({
    payloadBytes: utf8(statement),
    payloadType: VERDICT_DSSE_PAYLOAD_TYPE,
    signatures: [{ signature: new Uint8Array([1, 2, 3, 4]), keyid: "fake-key" }],
  });
}

function makeStatefulFakeBackend(evaluationSpecSha256: string): { backend: ProxiedBackend } {
  const byUri = new Map<string, { attempt: string; submission: string; deliveryDigestHex: string }>();
  const byIdempotencyKey = new Map<string, { bytesHash: string; ack: SubmissionAck }>();
  const bytesByHex = new Map<string, Uint8Array>();
  let counter = 0;

  function store(bytes: Uint8Array): string {
    const hex = sha256Hex(bytes);
    bytesByHex.set(hex, bytes);
    return hex;
  }

  const backend: ProxiedBackend = {
    async capabilities() {
      throw new Error("not used");
    },
    async submit(_taskBytes, submissionBytes) {
      const doc = JSON.parse(new TextDecoder().decode(submissionBytes)) as {
        idempotencyKey: string;
        submission: string;
        requirements?: { harness?: { id?: string } };
      };
      const bytesHash = sha256Hex(submissionBytes);
      const prior = byIdempotencyKey.get(doc.idempotencyKey);
      if (prior !== undefined) return prior.ack;
      counter += 1;
      const attempt = `urn:uuid:00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
      const isEval = doc.requirements?.harness?.id === "evaluation-harness";
      let artifactHex: string;
      if (isEval) {
        artifactHex = store(buildVerdictEnvelope({ evaluatorId: "urn:jinn:test:evaluator", evaluationSpecificationSha256: evaluationSpecSha256 }));
      } else {
        artifactHex = store(utf8({ probabilityYes: "0.5", submittedAt: "2026-01-01T00:00:00Z" }));
      }
      const outputName = isEval ? "verdict" : "prediction";
      const deliveryHex = store(utf8({ outputs: [{ name: outputName, digest: { sha256: artifactHex } }] }));
      byUri.set(doc.submission, { attempt, submission: doc.submission, deliveryDigestHex: deliveryHex });
      byUri.set(attempt, { attempt, submission: doc.submission, deliveryDigestHex: deliveryHex });
      const ack: SubmissionAck = { accepted: true, submission: doc.submission as SubmissionUri, digest: `sha256:${bytesHash}` };
      byIdempotencyKey.set(doc.idempotencyKey, { bytesHash, ack });
      return ack;
    },
    async observe(ref) {
      const found = byUri.get(ref as string);
      if (found === undefined) throw new Error(`fake: no attempt for ${String(ref)}`);
      const snapshot: ObservationSnapshot = {
        descriptor: {
          attempt: found.attempt as `urn:uuid:${string}`,
          task: `sha256:${"0".repeat(64)}`,
          submission: found.submission as `urn:uuid:${string}`,
          derived: { state: "delivered", terminal: true, contradictory: false, cancelRequested: false, executionIds: [], deliveries: [] },
        },
        cursor: { sequence: "0" },
        observations: [],
      };
      return snapshot;
    },
    async recover() {
      throw new Error("not used");
    },
    async deliveries(attempt) {
      const found = byUri.get(attempt as string);
      return found === undefined ? [] : [{ attempt: attempt as AttemptUri, digest: `sha256:${found.deliveryDigestHex}` } as DeliveryRef];
    },
    async fetchDelivery(ref) {
      const bytes = bytesByHex.get(ref.digest.slice("sha256:".length));
      if (bytes === undefined) throw new Error("fake: unknown delivery digest");
      return bytes;
    },
    async fetchArtifact(descriptor: ResourceDescriptor) {
      const sha256 = descriptor.digest?.["sha256"];
      const bytes = sha256 === undefined ? undefined : bytesByHex.get(sha256);
      if (bytes === undefined) throw new Error("fake: unknown artifact digest");
      return bytes;
    },
    async drain() {},
  };
  return { backend };
}

function fakeVenue(backend: ProxiedBackend): LocalVenue {
  return {
    backend: backend as unknown as LocalVenue["backend"],
    verdictKeyId: "fake-venue-verdict-key",
    prepareEvaluationCell: (input) => {
      const taskBytes = utf8({ fakeEvalTask: true, subjectDigest: sha256Hex(input.subjectTaskBytes) });
      return { taskBytes, taskSha256: sha256Hex(taskBytes) };
    },
    async shutdown() {},
  };
}

async function setUpDrivenRun(clock: () => string, draftId = "draft-1"): Promise<{ evaluationSpecSha256: string }> {
  initWorkspace(contextFor(clock));
  createDraft(contextFor(clock), { draftId, name: "Collect Test" });
  const sample = await sampleInit(contextFor(clock), { draftId });
  expect(sample.ok).toBe(true);
  if (!sample.ok) throw new Error("unreachable");
  armAdd(contextFor(clock), { draftId, armId: "baseline", pinning: { harness: { id: "prediction-v1-baseline", version: "1.0.0" } } });
  armAdd(contextFor(clock), { draftId, armId: "sample", pinning: { harness: { id: "sample-uniform", version: "0.1.0" } } });
  const quoted = await runQuote(contextFor(clock), { draftId });
  expect(quoted.ok).toBe(true);
  const locked = runLock(contextFor(clock), { draftId });
  expect(locked.ok).toBe(true);

  const { backend } = makeStatefulFakeBackend(sample.result.evaluationSpecSha256);
  const launched = await runLaunch(contextFor(clock), { draftId }, { createVenue: () => fakeVenue(backend) });
  expect(launched.ok).toBe(true);

  return { evaluationSpecSha256: sample.result.evaluationSpecSha256 };
}

describe("runCollect — guards", () => {
  test("refuses illegal-transition when the draft is not running", async () => {
    const clock = makeClock();
    initWorkspace(contextFor(clock));
    createDraft(contextFor(clock), { draftId: "draft-1", name: "Never Launched" });

    const outcome = await runCollect(contextFor(clock), { draftId: "draft-1" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("illegal-transition");
  });

  test("refuses conflict when cells remain outstanding and closeAt has not passed", async () => {
    const clock = makeClock();
    await setUpDrivenRun(clock);
    const fullEntries = readRunJournalEntries(workspaceDir, "draft-1");
    const deliveredCells = fullEntries
      .filter((entry) => entry.kind === "cell-event" && entry.event.kind === "delivered")
      .map((entry) => (entry.kind === "cell-event" ? entry.event.cellKey : ""));
    const [droppedCellKey] = deliveredCells;
    const truncated = fullEntries.filter((entry) => {
      if (entry.kind === "cell-event") return entry.event.cellKey !== droppedCellKey;
      if (entry.kind === "submission-accepted" || entry.kind === "delivery" || entry.kind === "evaluation") {
        return entry.cellKey !== droppedCellKey;
      }
      return true;
    });
    atomicWriteFileSync(runJournalPath(workspaceDir, "draft-1"), `${truncated.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

    const outcome = await runCollect(contextFor(clock), { draftId: "draft-1" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("conflict");

    // The draft was NOT advanced to closed by a refused collect attempt.
    expect(readDraftDocument(workspaceDir, "draft-1").state).toBe("running");
  }, 30_000);

  test("succeeds despite an outstanding cell once closeAt has passed", async () => {
    const clock = makeClock();
    await setUpDrivenRun(clock);
    const fullEntries = readRunJournalEntries(workspaceDir, "draft-1");
    const deliveredCells = fullEntries
      .filter((entry) => entry.kind === "cell-event" && entry.event.kind === "delivered")
      .map((entry) => (entry.kind === "cell-event" ? entry.event.cellKey : ""));
    const [droppedCellKey] = deliveredCells;
    const truncated = fullEntries.filter((entry) => {
      if (entry.kind === "cell-event") return entry.event.cellKey !== droppedCellKey;
      if (entry.kind === "submission-accepted" || entry.kind === "delivery" || entry.kind === "evaluation") {
        return entry.cellKey !== droppedCellKey;
      }
      return true;
    });
    atomicWriteFileSync(runJournalPath(workspaceDir, "draft-1"), `${truncated.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

    // Force the Run's pre-registered close boundary into the past relative to the test clock.
    const runState = readRunState(workspaceDir, "draft-1");
    expect(runState).toBeDefined();
    if (runState === undefined) return;
    writeRunState(workspaceDir, "draft-1", { ...runState, closeAt: "2020-01-01T00:00:00Z" });

    const outcome = await runCollect(contextFor(clock), { draftId: "draft-1" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.draft.state).toBe("closed");

    const matrix = parseMatrix(getSealedBytes(workspaceDir, outcome.result.matrixSha256));
    expect(matrix.cells).toHaveLength(6);
    const droppedCell = matrix.cells.find((cell) => cell.cellKey === droppedCellKey);
    expect(droppedCell).toMatchObject({ dispatches: 0, outcome: "expired" });
    // Every OTHER cell still reaches "judged" despite the one never-dispatched cell.
    const judgedCount = matrix.cells.filter((cell) => cell.outcome === "judged").length;
    expect(judgedCount).toBe(5);
    expect(matrix.completeness.runOutcome).toBe("partial");
  }, 30_000);
});

describe("runCollect — full assembly (fake backend, driven run)", () => {
  test("every cell judged; RunState.matrixSha256 set; solver/evaluator identities resolved; re-derivable integrity from the real admission receipt", async () => {
    const clock = makeClock();
    await setUpDrivenRun(clock);

    const outcome = await runCollect(contextFor(clock), { draftId: "draft-1" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.draft.state).toBe("closed");

    const runState = readRunState(workspaceDir, "draft-1");
    expect(runState?.matrixSha256).toBe(outcome.result.matrixSha256);
    expect(runState?.closedAt).toBeDefined();

    const matrix = parseMatrix(getSealedBytes(workspaceDir, outcome.result.matrixSha256));
    expect(matrix.cells).toHaveLength(6);
    expect(matrix.completeness).toMatchObject({ expected: 6, judged: 6, runOutcome: "complete" });

    // run-collect.ts's trust resolver echoes each verdict's OWN claimed evaluator IRI (the
    // venue's real evaluator identity, `readVerdictEnvelope`'s `evaluatorId`) — this fixture's
    // fake backend stamps every verdict with "urn:jinn:test:evaluator" (see buildVerdictEnvelope
    // above), so that is exactly what the resolved identity should be.
    for (const cell of matrix.cells) {
      expect(cell.outcome, cell.cellKey).toBe("judged");
      expect(cell.verification.harness, cell.cellKey).toBe("match");
      // The bundled sample's real admission receipt (BP-11) makes this a re-derivable cell.
      expect(cell.integrityTier, cell.cellKey).toBe("re-derivable");
      expect(cell.solver, cell.cellKey).toBe(runState?.owner);
      expect(cell.evaluator, cell.cellKey).toBe("urn:jinn:test:evaluator");
    }

    const closedEntry = readRunJournalEntries(workspaceDir, "draft-1").find((entry) => entry.kind === "closed");
    expect(closedEntry).toMatchObject({ matrixSha256: outcome.result.matrixSha256 });
  }, 30_000);

  test("collecting an already-closed draft refuses illegal-transition (never double-seals)", async () => {
    const clock = makeClock();
    await setUpDrivenRun(clock);
    const first = await runCollect(contextFor(clock), { draftId: "draft-1" });
    expect(first.ok).toBe(true);

    const second = await runCollect(contextFor(clock), { draftId: "draft-1" });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe("illegal-transition");
  }, 30_000);
});
