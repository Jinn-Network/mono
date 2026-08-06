import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type {
  AttemptUri,
  DeliveryRef,
  ObservationSnapshot,
  SubmissionAck,
  SubmissionUri,
} from "@jinn-network/task-execution-backend";
import type { ResourceDescriptor } from "@jinn-network/task-execution-protocol";
import { readAuditEntries } from "../audit/journal.js";
import { atomicWriteFileSync } from "../fs/atomic.js";
import type { ProxiedBackend } from "../run/drive.js";
import { readRunJournalEntries } from "../run/journal.js";
import { readRunState } from "../run/state.js";
import { runJournalPath } from "../workspace/layout.js";
import { sha256Hex } from "../workspace/sealed-store.js";
import type { LocalVenue } from "../venue/venue.js";
import { armAdd } from "./arms.js";
import { authorityGrant } from "./authority-ops.js";
import type { OperationContext } from "./context.js";
import { createDraft, readDraftDocument } from "./drafts.js";
import { initWorkspace } from "./init.js";
import { runLaunch, runResume } from "./run-launch.js";
import { runLock } from "./run-lock.js";
import { runQuote } from "./run-quote.js";
import { sampleInit } from "./sample.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bp12-run-launch-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

/**
 * A driven run's clock ticks far more often than a single operation's (`launchAndWatch` reads
 * `opts.clock.now()` repeatedly per cell, and every journal entry stamps its own `at`) — a
 * two-digit-seconds counter overflows past a full multi-cell run. Real `Date` arithmetic
 * sidesteps that by construction: minute/hour/day rollover is handled for free.
 */
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
  const created = createDraft(contextFor(clock), { draftId, name: "Launch Test" });
  expect(created.ok).toBe(true);
  await sampleInit(contextFor(clock), { draftId });
  armAdd(contextFor(clock), { draftId, armId: "baseline", pinning: { harness: { id: "prediction-v1-baseline", version: "1.0.0" } } });
  armAdd(contextFor(clock), { draftId, armId: "sample", pinning: { harness: { id: "sample-uniform", version: "0.1.0" } } });
  const quoted = await runQuote(contextFor(clock), { draftId });
  expect(quoted.ok).toBe(true);
  const locked = runLock(contextFor(clock), { draftId });
  expect(locked.ok).toBe(true);
}

// ── a small stateful in-memory fake backend + venue (no subprocess, always-immediate-terminal) ──

interface FakeAttempt {
  readonly attempt: string;
  readonly submission: string;
  readonly deliveryDigestHex: string;
}

function utf8(json: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(json));
}

/**
 * Every submit() immediately produces a "delivered" terminal — no watch loop, no
 * `capabilities()` call (`launchAndWatch` only calls `capabilities()` inside
 * `waitForAttemptTerminal`, which this fake never reaches because `observe()` already reports
 * `terminal: true` on the very first call).
 */
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
      const artifactHex = store(utf8({ fake: true, outputName, counter }));
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

function fakeVenue(backend: ProxiedBackend): LocalVenue {
  return {
    backend: backend as unknown as LocalVenue["backend"],
    verdictKeyId: "fake-verdict-key",
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

describe("runLaunch — lifecycle guard", () => {
  test("refuses illegal-transition when the draft is not locked", async () => {
    const clock = makeClock();
    initWorkspace(contextFor(clock));
    createDraft(contextFor(clock), { draftId: "draft-1", name: "Never Locked" });

    const outcome = await runLaunch(contextFor(clock), { draftId: "draft-1" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("illegal-transition");
  });

  test("venue construction failure surfaces as venue-unavailable", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);

    const outcome = await runLaunch(contextFor(clock), { draftId: "draft-1" }, {
      createVenue: () => {
        throw new Error("boom");
      },
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("venue-unavailable");

    // The draft was NOT advanced to running — venue construction failed before any drive work,
    // but AFTER the state was already written per this operation's own "advance first" design.
    // Document the actual behavior rather than assume: launch stamps state before booting the
    // venue, so a venue failure still leaves the draft "running" with an empty journal.
    const document = readDraftDocument(workspaceDir, "draft-1");
    expect(document.state).toBe("running");
  }, 30_000);
});

describe("runLaunch — gating (authority-denied / grant)", () => {
  test("an ungranted delegated agent is refused, audited under the denied principal", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    authorityGrant(contextFor(clock), { principalId: "agent-1", operations: [] });

    const denied = await runLaunch(contextFor(clock, "agent-1"), { draftId: "draft-1" });
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.error.code).toBe("authority-denied");

    const entries = readAuditEntries(workspaceDir);
    expect(entries[entries.length - 1]).toMatchObject({ action: "launch", actor: "agent-1", outcome: "authority-denied" });

    // Denial happens before any state mutation.
    expect(readDraftDocument(workspaceDir, "draft-1").state).toBe("locked");
  }, 30_000);

  test("a granted principal can launch (drives via the injected fake venue)", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    authorityGrant(contextFor(clock), { principalId: "agent-1", operations: ["launch"] });
    const { backend } = makeStatefulFakeBackend();

    const outcome = await runLaunch(contextFor(clock, "agent-1"), { draftId: "draft-1" }, { createVenue: () => fakeVenue(backend) });
    expect(outcome.ok).toBe(true);
  }, 30_000);
});

describe("runLaunch — drives a full 2-arm run to completion (fake backend)", () => {
  test("every expected cell reaches delivered + judged; RunState.launchedAt set; draft running", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    const { backend, submits } = makeStatefulFakeBackend();

    const outcome = await runLaunch(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => fakeVenue(backend) });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.draft.state).toBe("running");

    const state = readRunState(workspaceDir, "draft-1");
    expect(state?.launchedAt).toBeDefined();

    const entries = readRunJournalEntries(workspaceDir, "draft-1");
    expect(entries[0]).toMatchObject({ kind: "launched" });

    // 2 arms x 3 sample tasks x 1 replicate = 6 expected cells.
    const deliveredEvents = entries.filter((entry) => entry.kind === "cell-event" && entry.event.kind === "delivered");
    expect(deliveredEvents).toHaveLength(6);
    const deliveryEntries = entries.filter((entry) => entry.kind === "delivery");
    expect(deliveryEntries).toHaveLength(6);
    const evaluationEntries = entries.filter((entry) => entry.kind === "evaluation");
    expect(evaluationEntries).toHaveLength(6);
    expect(evaluationEntries.every((entry) => entry.kind === "evaluation" && entry.verdictSha256 !== undefined)).toBe(true);

    // Every eval Submission pinned the evaluation-harness requirement.
    const evalSubmits = submits.filter((call) => {
      const doc = JSON.parse(new TextDecoder().decode(call.submissionBytes)) as { requirements?: { harness?: { id?: string } } };
      return doc.requirements?.harness?.id === "evaluation-harness";
    });
    expect(evalSubmits).toHaveLength(6);
  }, 30_000);
});

describe("runResume — lifecycle guard", () => {
  test("refuses illegal-transition when the draft is not running", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);

    const outcome = await runResume(contextFor(clock), { draftId: "draft-1" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("illegal-transition");
  });

  test("ungated: a bare workspace member with no grants can resume", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    const { backend } = makeStatefulFakeBackend();
    const launched = await runLaunch(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => fakeVenue(backend) });
    expect(launched.ok).toBe(true);

    authorityGrant(contextFor(clock), { principalId: "agent-1", operations: [] });
    const outcome = await runResume(contextFor(clock, "agent-1"), { draftId: "draft-1" }, { createVenue: () => fakeVenue(backend) });
    expect(outcome.ok).toBe(true);
  }, 30_000);
});

/** Rewrites the run journal to exactly `entries` — a test-only fixture technique (the append-only
 * journal has no public rewrite API); simulates "the process was killed and lost everything
 * after this point" more faithfully than trying to interrupt a live async generator mid-stream. */
function overwriteRunJournal(draftId: string, entries: readonly unknown[]): void {
  atomicWriteFileSync(runJournalPath(workspaceDir, draftId), `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

describe("runResume — re-dispatches only outstanding cells", () => {
  test("a cell whose journal entries are entirely missing (crash before it was ever dispatched) is picked up; already-complete cells are untouched", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    const { backend: launchBackend } = makeStatefulFakeBackend();
    const launched = await runLaunch(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => fakeVenue(launchBackend) });
    expect(launched.ok).toBe(true);
    const fullEntries = readRunJournalEntries(workspaceDir, "draft-1");
    const deliveredCells = fullEntries
      .filter((entry) => entry.kind === "cell-event" && entry.event.kind === "delivered")
      .map((entry) => (entry.kind === "cell-event" ? entry.event.cellKey : ""));
    expect(deliveredCells).toHaveLength(6);
    const [droppedCellKey] = deliveredCells;
    expect(droppedCellKey).toBeDefined();

    // Simulate "launch crashed before this one cell was ever touched": drop every journal entry
    // naming it, keeping the other 5 cells' entries (and the launched marker) intact.
    const truncated = fullEntries.filter((entry) => {
      if (entry.kind === "cell-event") return entry.event.cellKey !== droppedCellKey;
      if (entry.kind === "submission-accepted" || entry.kind === "delivery" || entry.kind === "evaluation") {
        return entry.cellKey !== droppedCellKey;
      }
      return true;
    });
    expect(truncated.length).toBeLessThan(fullEntries.length);
    overwriteRunJournal("draft-1", truncated);

    const { backend: resumeBackend, submits } = makeStatefulFakeBackend();
    const outcome = await runResume(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => fakeVenue(resumeBackend) });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.outstandingCount).toBe(1);
    expect(outcome.result.evaluationCatchUpCount).toBe(0);
    // Exactly the dropped cell's solve + evaluation Submissions were (re-)dispatched.
    expect(submits.length).toBe(2);

    const afterEntries = readRunJournalEntries(workspaceDir, "draft-1");
    const nowDelivered = afterEntries.filter((entry) => entry.kind === "cell-event" && entry.event.kind === "delivered");
    expect(nowDelivered).toHaveLength(6);
    const nowEvaluated = afterEntries.filter((entry) => entry.kind === "evaluation" && entry.verdictSha256 !== undefined);
    expect(nowEvaluated).toHaveLength(6);

    // The other 5 cells' entries were not touched — no duplicate dispatch/delivery for them.
    const untouchedCellKeys = deliveredCells.filter((cellKey) => cellKey !== droppedCellKey);
    for (const cellKey of untouchedCellKeys) {
      const original = fullEntries.filter((entry) =>
        (entry.kind === "cell-event" && entry.event.cellKey === cellKey)
        || (entry.kind !== "cell-event" && entry.kind !== "launched" && entry.kind !== "closed" && entry.cellKey === cellKey));
      const after = afterEntries.filter((entry) =>
        (entry.kind === "cell-event" && entry.event.cellKey === cellKey)
        || (entry.kind !== "cell-event" && entry.kind !== "launched" && entry.kind !== "closed" && entry.cellKey === cellKey));
      expect(after).toEqual(original);
    }
  }, 30_000);

  test("a clean run with nothing outstanding is a true no-op on resume", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    const { backend: launchBackend } = makeStatefulFakeBackend();
    const launched = await runLaunch(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => fakeVenue(launchBackend) });
    expect(launched.ok).toBe(true);
    const before = readRunJournalEntries(workspaceDir, "draft-1");

    const { backend: resumeBackend, submits } = makeStatefulFakeBackend();
    const outcome = await runResume(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => fakeVenue(resumeBackend) });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.outstandingCount).toBe(0);
    expect(outcome.result.evaluationCatchUpCount).toBe(0);
    expect(submits).toHaveLength(0);
    expect(readRunJournalEntries(workspaceDir, "draft-1")).toEqual(before);
  }, 30_000);
});

describe("runResume — evaluation catch-up", () => {
  test("re-runs only the evaluation leg for a delivered-but-unevaluated cell, without re-dispatching solve", async () => {
    const clock = makeClock();
    await setUpLockedDraft(clock);
    const { backend: launchBackend } = makeStatefulFakeBackend();
    const launched = await runLaunch(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => fakeVenue(launchBackend) });
    expect(launched.ok).toBe(true);
    const fullEntries = readRunJournalEntries(workspaceDir, "draft-1");
    const deliveredCells = fullEntries
      .filter((entry) => entry.kind === "cell-event" && entry.event.kind === "delivered")
      .map((entry) => (entry.kind === "cell-event" ? entry.event.cellKey : ""));
    const [gapCellKey] = deliveredCells;
    expect(gapCellKey).toBeDefined();

    // Simulate "delivered, then the process died before the verdict was journaled": drop just
    // the gap cell's own "evaluation" entry, keeping its cell-event and delivery entries intact.
    const missingVerdict = fullEntries.filter((entry) => !(entry.kind === "evaluation" && entry.cellKey === gapCellKey));
    expect(missingVerdict.length).toBe(fullEntries.length - 1);
    overwriteRunJournal("draft-1", missingVerdict);

    const { backend: resumeBackend, submits } = makeStatefulFakeBackend();
    const outcome = await runResume(contextFor(clock), { draftId: "draft-1" }, { createVenue: () => fakeVenue(resumeBackend) });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The solve side is done — nothing is outstanding; only the evaluation catch-up sweep runs.
    expect(outcome.result.outstandingCount).toBe(0);
    expect(outcome.result.evaluationCatchUpCount).toBe(1);
    // Exactly one (evaluation-only) Submission was dispatched — no solve resubmission.
    expect(submits).toHaveLength(1);
    const submittedDoc = JSON.parse(new TextDecoder().decode(submits[0]!.submissionBytes)) as { requirements?: { harness?: { id?: string } } };
    expect(submittedDoc.requirements?.harness?.id).toBe("evaluation-harness");

    const afterEntries = readRunJournalEntries(workspaceDir, "draft-1");
    const gapEvaluation = afterEntries.find((entry) => entry.kind === "evaluation" && entry.cellKey === gapCellKey);
    expect(gapEvaluation).toMatchObject({ cellKey: gapCellKey, verdictSha256: expect.any(String) });

    // No NEW cell-event or delivery entries were written for the gap cell — solve side untouched.
    const gapCellEvents = afterEntries.filter((entry) =>
      (entry.kind === "cell-event" && entry.event.cellKey === gapCellKey) || (entry.kind === "delivery" && entry.cellKey === gapCellKey));
    const originalGapCellEvents = fullEntries.filter((entry) =>
      (entry.kind === "cell-event" && entry.event.cellKey === gapCellKey) || (entry.kind === "delivery" && entry.cellKey === gapCellKey));
    expect(gapCellEvents).toEqual(originalGapCellEvents);
  }, 30_000);
});
