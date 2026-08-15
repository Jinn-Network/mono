import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseMatrix } from "@jinn-network/benchmarking-records";
import type {
  AttemptUri,
  DeliveryRef,
  ObservationSnapshot,
  SubmissionAck,
  SubmissionUri,
} from "@jinn-network/task-execution-backend";
import { TaskExecutionError } from "@jinn-network/task-execution-backend";
import type { ResourceDescriptor } from "@jinn-network/task-execution-protocol";
import { VERDICT_DSSE_PAYLOAD_TYPE } from "@jinn-network/task-execution-profiles";
import { canonicalJsonBytes, dssePreAuthEncoding, sealDsseEnvelope } from "@jinn-network/trust-core";
import { readAuditEntries } from "../audit/journal.js";
import { atomicWriteFileSync } from "../fs/atomic.js";
import { cancelRequested, readCancelMarker, writeCancelMarker } from "../run/cancel-marker.js";
import type { ProxiedBackend } from "../run/drive.js";
import { readRunJournalEntries } from "../run/journal.js";
import { readRunState } from "../run/state.js";
import { runCancelMarkerPath, runJournalPath } from "../workspace/layout.js";
import { getSealedBytes, sha256Hex } from "../workspace/sealed-store.js";
import { LEGACY_VERDICT_EVALUATOR_ID, loadOrCreateVerdictSigningKey } from "../venue/signing.js";
import type { LocalVenue } from "../venue/venue.js";
import { armAdd } from "./arms.js";
import { authorityGrant } from "./authority-ops.js";
import type { OperationContext } from "./context.js";
import { createDraft, readDraftDocument } from "./drafts.js";
import { initWorkspace } from "./init.js";
import { runCancel } from "./run-cancel.js";
import { runCollect } from "./run-collect.js";
import { runLaunch, runResume } from "./run-launch.js";
import { runLock } from "./run-lock.js";
import { runQuote } from "./run-quote.js";
import { sampleInit } from "./sample.js";

let workspaceDir: string;
let evaluationSpecSha256: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bp22-run-cancel-"));
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

async function setUpLockedDraft(clock: () => string, draftId = "draft-1"): Promise<void> {
  initWorkspace(contextFor(clock));
  const created = createDraft(contextFor(clock), { draftId, name: "Cancel Test" });
  expect(created.ok).toBe(true);
  const sample = await sampleInit(contextFor(clock), { draftId });
  expect(sample.ok).toBe(true);
  if (!sample.ok) throw new Error("unreachable");
  evaluationSpecSha256 = sample.result.evaluationSpecSha256;
  armAdd(contextFor(clock), { draftId, armId: "baseline", pinning: { harness: { id: "prediction-v1-baseline", version: "1.0.0" } } });
  armAdd(contextFor(clock), { draftId, armId: "sample", pinning: { harness: { id: "sample-uniform", version: "0.1.0" } } });
  const quoted = await runQuote(contextFor(clock), { draftId });
  expect(quoted.ok).toBe(true);
  const locked = runLock(contextFor(clock), { draftId });
  expect(locked.ok).toBe(true);
}

// ── a small stateful in-memory fake backend + venue (no subprocess, always-immediate-terminal) ──
// Mirrors run-launch.test.ts's own fixture, with a `preflight` method added to the backend (BP-22
// decision 3's venue-liveness probe) — the real `LocalTaskExecutionBackend.preflight` is what
// `run-cancel.ts` calls; these unit tests script its resolution/rejection directly.

interface FakeAttempt {
  readonly attempt: string;
  readonly submission: string;
  readonly deliveryDigestHex: string;
}

function utf8(json: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(json));
}

/** A genuine workspace-key-signed verdict envelope. Cancellation unit tests use a fake backend
 * only to control cell timing, but Matrix assembly still exercises the real signature-verifying
 * trust resolver and therefore must receive honest verdict evidence rather than placeholder
 * JSON. */
function buildVerdictEnvelope(): Uint8Array {
  const statement = {
    predicateType: "https://spec.jinn.network/attestations/result-evaluation/v1",
    predicate: {
      evaluator: { id: LEGACY_VERDICT_EVALUATOR_ID },
      verdict: "pass",
      evaluationSpecification: { digest: { sha256: evaluationSpecSha256 } },
      measurements: [
        { name: "integrity", value: true },
        { name: "resolved", value: true },
      ],
      evaluatedAt: "2026-01-01T00:00:00Z",
    },
  };
  const key = loadOrCreateVerdictSigningKey(workspaceDir);
  const payloadBytes = canonicalJsonBytes(statement);
  return sealDsseEnvelope({
    payloadBytes,
    payloadType: VERDICT_DSSE_PAYLOAD_TYPE,
    signatures: [{ signature: key.sign(dssePreAuthEncoding(VERDICT_DSSE_PAYLOAD_TYPE, payloadBytes)), keyid: key.keyId }],
  });
}

function makeStatefulFakeBackend(): { backend: ProxiedBackend; submits: { taskBytes: Uint8Array; submissionBytes: Uint8Array }[] } {
  const byUri = new Map<string, FakeAttempt>();
  const byIdempotencyKey = new Map<string, { bytesHash: string; ack: SubmissionAck }>();
  const bytesByHex = new Map<string, Uint8Array>();
  let counter = 0;
  const submits: { taskBytes: Uint8Array; submissionBytes: Uint8Array }[] = [];

  function store(bytes: Uint8Array): string {
    const hex = sha256Hex(bytes);
    bytesByHex.set(hex, bytes);
    return hex;
  }

  const backend: ProxiedBackend = {
    async capabilities() {
      throw new Error("fake backend: capabilities() should not be reached (always-terminal fake)");
    },
    async submit(taskBytes, submissionBytes) {
      submits.push({ taskBytes, submissionBytes });
      const doc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(submissionBytes)) as {
        idempotencyKey: string;
        submission: string;
        requirements?: { harness?: { id?: string } };
      };
      const bytesHash = sha256Hex(submissionBytes);
      const prior = byIdempotencyKey.get(doc.idempotencyKey);
      if (prior !== undefined) {
        if (prior.bytesHash !== bytesHash) {
          return { accepted: false, error: { category: "submission-conflict", detail: "idempotency key reused with different bytes" } as never };
        }
        return prior.ack;
      }
      counter += 1;
      const attempt = `urn:uuid:00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
      const isEval = doc.requirements?.harness?.id === "evaluation-harness";
      const outputName = isEval ? "verdict" : "prediction";
      const artifactHex = store(isEval ? buildVerdictEnvelope() : utf8({ fake: true, outputName, counter }));
      const deliveryHex = store(utf8({ outputs: [{ name: outputName, digest: { sha256: artifactHex } }] }));
      byUri.set(doc.submission, { attempt, submission: doc.submission, deliveryDigestHex: deliveryHex });
      byUri.set(attempt, { attempt, submission: doc.submission, deliveryDigestHex: deliveryHex });
      const ack: SubmissionAck = { accepted: true, submission: doc.submission as SubmissionUri, digest: `sha256:${bytesHash}` };
      byIdempotencyKey.set(doc.idempotencyKey, { bytesHash, ack });
      return ack;
    },
    async observe(ref) {
      const found = byUri.get(ref as string);
      if (found === undefined) throw new Error(`fake backend: no attempt for ref ${String(ref)}`);
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
      throw new Error("not used by these tests");
    },
    async deliveries(attempt) {
      const found = byUri.get(attempt as string);
      return found === undefined ? [] : [{ attempt: attempt as AttemptUri, digest: `sha256:${found.deliveryDigestHex}` } as DeliveryRef];
    },
    async fetchDelivery(ref) {
      const bytes = bytesByHex.get(ref.digest.slice("sha256:".length));
      if (bytes === undefined) throw new Error("fake backend: unknown delivery digest");
      return bytes;
    },
    async fetchArtifact(descriptor: ResourceDescriptor) {
      const sha256 = descriptor.digest?.["sha256"];
      const bytes = sha256 === undefined ? undefined : bytesByHex.get(sha256);
      if (bytes === undefined) throw new Error("fake backend: unknown artifact digest");
      return bytes;
    },
    async drain() {},
  };
  return { backend, submits };
}

/** A fake venue whose backend's `preflight` resolves `{ready: true}` by default — the "venue is
 * free" case `run-cancel.ts` probes for. Pass `preflight` to script a rejection instead (the
 * "venue is busy" case). */
function fakeVenue(
  backend: ProxiedBackend,
  options: { evaluatorCount?: number; preflight?: () => Promise<unknown> } = {},
): LocalVenue {
  const evaluatorCount = options.evaluatorCount ?? 1;
  const evaluators = Array.from({ length: evaluatorCount }, (_, i) => ({
    id: `urn:jinn:benchmark-product:local-venue:evaluator-${i + 1}`,
    keyId: `fake-verdict-key-${i + 1}`,
  }));
  const backendWithPreflight = {
    ...backend,
    preflight: options.preflight ?? (async () => ({ ready: true })),
  };
  return {
    backend: backendWithPreflight as unknown as LocalVenue["backend"],
    verdictKeyId: evaluators[0]!.keyId,
    evaluators,
    prepareEvaluationCell: (input) => {
      const taskBytes = utf8({
        fakeEvalTask: true,
        subjectDigest: sha256Hex(input.subjectTaskBytes),
        specDigest: sha256Hex(input.evaluationSpecBytes),
      });
      return { taskBytes, taskSha256: sha256Hex(taskBytes) };
    },
    async shutdown() {},
  };
}

/** Rewrites the run journal to exactly `entries` — a test-only fixture technique (the append-only
 * journal has no public rewrite API); simulates "the process was killed and lost everything
 * after this point" more faithfully than trying to interrupt a live async generator mid-stream. */
function overwriteRunJournal(draftId: string, entries: readonly unknown[]): void {
  atomicWriteFileSync(runJournalPath(workspaceDir, draftId), `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

describe("runCancel — gating", () => {
  test("an ungranted delegated agent is refused, audited under the denied principal", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    authorityGrant(contextFor(clock), { principalId: "agent-1", operations: [] });

    const denied = await runCancel(contextFor(clock, "agent-1"), { draftId: "draft-1" });
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.error.code).toBe("authority-denied");

    const entries = readAuditEntries(workspaceDir);
    expect(entries[entries.length - 1]).toMatchObject({ action: "cancel", actor: "agent-1", outcome: "authority-denied" });

    // Denial happens before any state mutation — no marker was written.
    expect(cancelRequested(workspaceDir, "draft-1")).toBe(false);
  });

  test("a principal with the cancel grant can cancel", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    const { backend } = makeStatefulFakeBackend();
    const launched = await runLaunch(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => fakeVenue(backend) });
    expect(launched.ok).toBe(true);

    authorityGrant(contextFor(clock), { principalId: "agent-1", operations: ["cancel"] });
    const { backend: cancelBackend } = makeStatefulFakeBackend();
    const outcome = await runCancel(contextFor(clock, "agent-1"), { draftId: "draft-1" }, { createVenue: () => fakeVenue(cancelBackend) });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.phase).toBe("cancelled");
  }, 30_000);
});

describe("runCancel — running-state guard", () => {
  test("fails closed before finalization when existing cancel-intent bytes are malformed", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    const { backend } = makeStatefulFakeBackend();
    const launched = await runLaunch(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => fakeVenue(backend) });
    expect(launched.ok).toBe(true);
    writeFileSync(runCancelMarkerPath(workspaceDir, "draft-1"), "not-json");

    const outcome = await runCancel(contextFor(clock), { draftId: "draft-1" }, {
      createVenue: () => { throw new Error("venue must not be opened for malformed durable intent"); },
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("record-integrity");
    expect(outcome.error.detail).toMatch(/cancel marker/iu);
  }, 30_000);

  test("refuses illegal-transition when the draft has never been launched (locked, not running)", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);

    const outcome = await runCancel(contextFor(clock), { draftId: "draft-1" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("illegal-transition");
    expect(cancelRequested(workspaceDir, "draft-1")).toBe(false);
  });

  test("refuses illegal-transition, audited, when the draft has already closed via run.collect", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    const { backend } = makeStatefulFakeBackend();
    const launched = await runLaunch(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => fakeVenue(backend) });
    expect(launched.ok).toBe(true);
    const collected = await runCollect(contextFor(clock), { draftId: "draft-1" });
    expect(collected.ok).toBe(true);

    const outcome = await runCancel(contextFor(clock), { draftId: "draft-1" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("illegal-transition");

    const entries = readAuditEntries(workspaceDir);
    expect(entries[entries.length - 1]).toMatchObject({ action: "cancel", outcome: "illegal-transition" });
  }, 30_000);

  test("does not bless a naturally complete Matrix merely because a stray cancel marker exists", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    const { backend } = makeStatefulFakeBackend();
    const launched = await runLaunch(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => fakeVenue(backend) });
    expect(launched.ok).toBe(true);
    const collected = await runCollect(contextFor(clock), { draftId: "draft-1" });
    expect(collected.ok).toBe(true);
    writeCancelMarker(workspaceDir, "draft-1", { requestedAt: clock(), principal: "sponsor-1" });

    const outcome = await runCancel(contextFor(clock), { draftId: "draft-1" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("record-integrity");
    expect(outcome.error.detail).toMatch(/not cancelled/iu);
  }, 30_000);
});

describe("runCancel — full finalize on a fake venue", () => {
  test("drains outstanding cells (including never-dispatched), seals a cancelled Matrix, closes the draft", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    const { backend: launchBackend } = makeStatefulFakeBackend();
    const launched = await runLaunch(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => fakeVenue(launchBackend) });
    expect(launched.ok).toBe(true);

    // Simulate "launch crashed before two of the six cells were ever touched": drop every
    // journal entry naming them, keeping the other four cells' entries intact.
    const fullEntries = readRunJournalEntries(workspaceDir, "draft-1");
    const deliveredCells = fullEntries
      .filter((entry) => entry.kind === "cell-event" && entry.event.kind === "delivered")
      .map((entry) => (entry.kind === "cell-event" ? entry.event.cellKey : ""));
    expect(deliveredCells.length).toBe(6);
    const [droppedA, droppedB] = deliveredCells;
    const targetKeys = new Set([droppedA, droppedB]);
    const truncated = fullEntries.filter((entry) => {
      if (entry.kind === "cell-event") return !targetKeys.has(entry.event.cellKey);
      if (entry.kind === "submission-captured" || entry.kind === "submission-pinning-evidence" || entry.kind === "submission-accepted" || entry.kind === "observation-accepted" || entry.kind === "delivery" || entry.kind === "evaluation") {
        return !targetKeys.has(entry.cellKey);
      }
      return true;
    });
    overwriteRunJournal("draft-1", truncated);

    const { backend: cancelBackend } = makeStatefulFakeBackend();
    const outcome = await runCancel(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => fakeVenue(cancelBackend) });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.phase).toBe("cancelled");
    if (outcome.result.phase !== "cancelled") return;

    // Draft closed.
    expect(outcome.result.draft.state).toBe("closed");
    expect(readDraftDocument(workspaceDir, "draft-1").state).toBe("closed");

    // RunState updated.
    const runState = readRunState(workspaceDir, "draft-1");
    expect(runState?.matrixSha256).toBe(outcome.result.matrixSha256);
    expect(runState?.closedAt).toBeDefined();

    // Matrix sealed with the cancellation accounted.
    const matrix = parseMatrix(getSealedBytes(workspaceDir, outcome.result.matrixSha256));
    expect(matrix.cells).toHaveLength(6);
    expect(matrix.completeness.runOutcome).toBe("cancelled");
    for (const cellKey of [droppedA, droppedB]) {
      const cell = matrix.cells.find((candidate) => candidate.cellKey === cellKey);
      expect(cell, cellKey).toMatchObject({ dispatches: 0, outcome: "expired" });
    }
    const judgedCount = matrix.cells.filter((cell) => cell.outcome === "judged").length;
    expect(judgedCount).toBe(4);

    // The drain journaled a "cancelled" terminal for each never-dispatched cell.
    const afterEntries = readRunJournalEntries(workspaceDir, "draft-1");
    for (const cellKey of [droppedA, droppedB]) {
      const cancelledEvent = afterEntries.find(
        (entry) => entry.kind === "cell-event" && entry.event.cellKey === cellKey && entry.event.kind === "cancelled",
      );
      expect(cancelledEvent, cellKey).toMatchObject({ event: { cancelledRun: true, detail: "drain-to-boundary" } });
    }

    // Exactly one cancel-requested entry, and a closed entry naming the sealed Matrix.
    expect(afterEntries.filter((entry) => entry.kind === "cancel-requested")).toHaveLength(1);
    const closedEntry = afterEntries.find((entry) => entry.kind === "closed");
    expect(closedEntry).toMatchObject({ matrixSha256: outcome.result.matrixSha256 });
  }, 30_000);

  test("cancelling a run with nothing outstanding still marks the Matrix cancelled (every cell stays judged)", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    const { backend: launchBackend } = makeStatefulFakeBackend();
    const launched = await runLaunch(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => fakeVenue(launchBackend) });
    expect(launched.ok).toBe(true);

    const { backend: cancelBackend } = makeStatefulFakeBackend();
    const outcome = await runCancel(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => fakeVenue(cancelBackend) });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok || outcome.result.phase !== "cancelled") return;

    const matrix = parseMatrix(getSealedBytes(workspaceDir, outcome.result.matrixSha256));
    expect(matrix.completeness.runOutcome).toBe("cancelled");
    expect(matrix.cells.every((cell) => cell.outcome === "judged")).toBe(true);
  }, 30_000);
});

describe("runCancel — cell-level outcomes are decided independently of the run-level cancelled flag", () => {
  test("a cell already 'expired' from a natural terminal before cancel keeps matrix outcome 'expired' after the drain", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    const { backend: launchBackend } = makeStatefulFakeBackend();
    const launched = await runLaunch(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => fakeVenue(launchBackend) });
    expect(launched.ok).toBe(true);

    const fullEntries = readRunJournalEntries(workspaceDir, "draft-1");
    const deliveredCells = fullEntries
      .filter((entry) => entry.kind === "cell-event" && entry.event.kind === "delivered")
      .map((entry) => (entry.kind === "cell-event" ? entry.event.cellKey : ""));
    const [expiredCellKey] = deliveredCells;
    if (expiredCellKey === undefined) throw new Error("unreachable");

    // Replace that one cell's entries with "dispatched, then naturally expired" — no delivery
    // ever happened, and no cancellation is involved yet.
    const dispatchEntry = fullEntries.find(
      (entry) => entry.kind === "cell-event" && entry.event.cellKey === expiredCellKey && entry.event.kind === "dispatch",
    );
    if (dispatchEntry === undefined || dispatchEntry.kind !== "cell-event") throw new Error("unreachable");
    const submissionEntry = fullEntries.find(
      (entry) => entry.kind === "submission-accepted" && entry.cellKey === expiredCellKey && entry.leg === "solve",
    );
    if (submissionEntry === undefined || submissionEntry.kind !== "submission-accepted") throw new Error("unreachable");
    const withoutTarget = fullEntries.filter((entry) => {
      if (entry.kind === "cell-event") return entry.event.cellKey !== expiredCellKey;
      if (entry.kind === "submission-captured" || entry.kind === "submission-pinning-evidence" || entry.kind === "submission-accepted" || entry.kind === "observation-accepted" || entry.kind === "delivery" || entry.kind === "evaluation") {
        return entry.cellKey !== expiredCellKey;
      }
      return true;
    });
    overwriteRunJournal("draft-1", [
      ...withoutTarget,
      submissionEntry,
      dispatchEntry,
      {
        kind: "cell-event",
        at: clock(),
        event: { ...dispatchEntry.event, kind: "error", replaceable: true, replaceableReason: "expired", detail: "expired" },
      },
    ]);

    const { backend: cancelBackend } = makeStatefulFakeBackend();
    const outcome = await runCancel(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => fakeVenue(cancelBackend) });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok || outcome.result.phase !== "cancelled") return;

    const matrix = parseMatrix(getSealedBytes(workspaceDir, outcome.result.matrixSha256));
    const cell = matrix.cells.find((candidate) => candidate.cellKey === expiredCellKey);
    // The MATRIX's own outcome vocabulary carries no "cancelled" value — a never-delivered cell
    // stays "expired" whether it got there via a natural deadline or via cancel's own drain.
    expect(cell?.outcome).toBe("expired");
    expect(matrix.completeness.runOutcome).toBe("cancelled");

    // The journal's own fold status DID flip to "cancelled" (the drain's own terminal is the
    // last cell-event) — distinct product-level detail the results/status surfaces separately
    // (`run-results.ts`'s `failure` block), never folded into the Matrix's score vocabulary.
    const afterEntries = readRunJournalEntries(workspaceDir, "draft-1");
    const lastEventForCell = [...afterEntries]
      .reverse()
      .find((entry) => entry.kind === "cell-event" && entry.event.cellKey === expiredCellKey);
    expect(lastEventForCell).toMatchObject({ event: { kind: "cancelled" } });
  }, 30_000);
});

describe("runCancel — marker-resume: a busy venue records the request without finalizing", () => {
  test("recognizes a typed contention error loaded through a second portal module identity", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    const { backend: launchBackend } = makeStatefulFakeBackend();
    const launched = await runLaunch(contextFor(clock), { draftId: "draft-1" }, {
      createVenue: () => fakeVenue(launchBackend),
    });
    expect(launched.ok).toBe(true);

    class PortalTaskExecutionError extends Error {
      readonly category = "backend-unavailable";
      readonly retryable = true;
      readonly detail = "state root writer already held through portal";
      readonly annotations = { reason: "state-root-locked" };

      constructor() {
        super("backend-unavailable");
        this.name = "TaskExecutionError";
      }
    }

    const outcome = await runCancel(contextFor(clock), { draftId: "draft-1" }, {
      createVenue: () => {
        throw new PortalTaskExecutionError();
      },
    });

    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result).toMatchObject({
      phase: "requested",
      reason: "venue-contention",
      detail: "state root writer already held through portal",
    });
  });

  test("phase 'requested' when the venue is busy; resume/collect refuse conflict; second and terminal-idempotent third cancels never duplicate durable facts", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    const { backend: launchBackend } = makeStatefulFakeBackend();
    const launched = await runLaunch(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => fakeVenue(launchBackend) });
    expect(launched.ok).toBe(true);

    // First cancel: the venue is "busy" (createVenue itself throws, standing in for a live
    // driver holding the writer lock).
    const first = await runCancel(contextFor(clock), { draftId: "draft-1" }, {
      createVenue: () => {
        throw new TaskExecutionError("backend-unavailable", {
          detail: "state root writer already held",
          annotations: { reason: "state-root-locked" },
        });
      },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.result.phase).toBe("requested");
    if (first.result.phase !== "requested") return;
    expect(first.result).toMatchObject({ reason: "venue-contention" });
    expect(first.result.detail).toMatch(/writer already held/);

    // The request IS recorded: marker written, exactly one journal entry, draft still running.
    expect(cancelRequested(workspaceDir, "draft-1")).toBe(true);
    const afterFirst = readRunJournalEntries(workspaceDir, "draft-1");
    expect(afterFirst.filter((entry) => entry.kind === "cancel-requested")).toHaveLength(1);
    expect(readDraftDocument(workspaceDir, "draft-1").state).toBe("running");
    expect(readRunState(workspaceDir, "draft-1")?.matrixSha256).toBeUndefined();

    // Simulate the narrow interruption window after the atomic marker write but before its
    // journal echo. The retry must repair that missing entry independently of marker existence.
    overwriteRunJournal("draft-1", afterFirst.filter((entry) => entry.kind !== "cancel-requested"));
    expect(cancelRequested(workspaceDir, "draft-1")).toBe(true);
    expect(
      readRunJournalEntries(workspaceDir, "draft-1").filter((entry) => entry.kind === "cancel-requested"),
    ).toHaveLength(0);

    // An interrupted cancel resumes by re-running cancel, never by resume or collect.
    const resumeAttempt = await runResume(contextFor(clock), { draftId: "draft-1" });
    expect(resumeAttempt.ok).toBe(false);
    if (!resumeAttempt.ok) expect(resumeAttempt.error.code).toBe("conflict");

    const collectAttempt = await runCollect(contextFor(clock), { draftId: "draft-1" });
    expect(collectAttempt.ok).toBe(false);
    if (!collectAttempt.ok) expect(collectAttempt.error.code).toBe("conflict");

    // Second cancel: the venue is free this time.
    const { backend: cancelBackend } = makeStatefulFakeBackend();
    const second = await runCancel(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => fakeVenue(cancelBackend) });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.result.phase).toBe("cancelled");
    expect(readDraftDocument(workspaceDir, "draft-1").state).toBe("closed");

    // The missing cancel-requested journal echo was repaired exactly once by the second call.
    const afterSecond = readRunJournalEntries(workspaceDir, "draft-1");
    expect(afterSecond.filter((entry) => entry.kind === "cancel-requested")).toHaveLength(1);

    // Third cancel: terminal idempotency returns the exact already-sealed result without
    // acquiring a venue or adding another cancel-requested / closed journal entry.
    const third = await runCancel(contextFor(clock), { draftId: "draft-1" });
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    expect(third.result).toMatchObject({
      phase: "cancelled",
      matrixSha256: second.result.phase === "cancelled" ? second.result.matrixSha256 : undefined,
    });
    const afterThird = readRunJournalEntries(workspaceDir, "draft-1");
    expect(afterThird.filter((entry) => entry.kind === "cancel-requested")).toHaveLength(1);
    expect(afterThird.filter((entry) => entry.kind === "closed")).toHaveLength(1);
  }, 30_000);

  test("the marker also records the requesting principal", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    const { backend } = makeStatefulFakeBackend();
    const launched = await runLaunch(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => fakeVenue(backend) });
    expect(launched.ok).toBe(true);

    authorityGrant(contextFor(clock), { principalId: "agent-1", operations: ["cancel"] });
    const outcome = await runCancel(contextFor(clock, "agent-1"), { draftId: "draft-1" }, {
      createVenue: () => {
        throw new TaskExecutionError("backend-unavailable", {
          detail: "busy",
          annotations: { reason: "state-root-locked" },
        });
      },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.phase).toBe("requested");
    expect(readCancelMarker(workspaceDir, "draft-1")).toMatchObject({ principal: "agent-1" });
  }, 30_000);

  test("concurrent cancel callers preserve the first attribution and one durable intent", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    const { backend: launchBackend } = makeStatefulFakeBackend();
    const launched = await runLaunch(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => fakeVenue(launchBackend) });
    expect(launched.ok).toBe(true);
    authorityGrant(contextFor(clock), { principalId: "agent-1", operations: ["cancel"] });

    let announceFirstProbe!: () => void;
    const firstProbeStarted = new Promise<void>((resolve) => { announceFirstProbe = resolve; });
    let releaseFirstProbe!: () => void;
    const firstProbeRelease = new Promise<void>((resolve) => { releaseFirstProbe = resolve; });
    const { backend: firstBackend } = makeStatefulFakeBackend();
    const first = runCancel(contextFor(clock), { draftId: "draft-1" }, {
      createVenue: () => fakeVenue(firstBackend, {
        preflight: async () => {
          announceFirstProbe();
          await firstProbeRelease;
          throw new TaskExecutionError("backend-unavailable", {
            detail: "state root locked by a live instance",
            annotations: { reason: "state-root-locked" },
          });
        },
      }),
    });
    await firstProbeStarted;

    let secondVenueCreations = 0;
    const second = await runCancel(contextFor(clock, "agent-1"), { draftId: "draft-1" }, {
      createVenue: () => {
        secondVenueCreations += 1;
        throw new Error("must not create a second venue while cancel finalization is locked");
      },
    });
    expect(second.ok).toBe(true);
    if (!second.ok || second.result.phase !== "requested") return;
    expect(second.result.reason).toBe("finalization-contention");
    expect(secondVenueCreations).toBe(0);

    releaseFirstProbe();
    const firstOutcome = await first;
    expect(firstOutcome.ok).toBe(true);
    if (!firstOutcome.ok) return;
    expect(firstOutcome.result.phase).toBe("requested");
    expect(readCancelMarker(workspaceDir, "draft-1")?.principal).toBe("sponsor-1");
    expect(readRunJournalEntries(workspaceDir, "draft-1").filter((entry) => entry.kind === "cancel-requested")).toHaveLength(1);
  }, 30_000);
});
