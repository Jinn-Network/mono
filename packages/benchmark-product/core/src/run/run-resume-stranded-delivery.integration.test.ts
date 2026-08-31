/**
 * Resume must heal a cell killed between its `delivered` cell-event journal write and its
 * `delivery` journal write (issue #3081).
 *
 * Canary-proven defect (LoCoMo hard canary, 2026-08-27): `./drive.js`'s `driveCellEvents` journals
 * the solve-side `delivered` cell-event first, then `driveEvaluationForDelivery` harvests the
 * Delivery from the backend and journals the `delivery` entry. The window between those two writes
 * was measured at 87-130 ms per cell. A process killed inside it leaves a cell that no public
 * operation can move:
 *
 * - `./journal.js`'s `outstandingCells` folds the cell as `delivered` — a non-replaceable terminal
 *   — so it is NOT solve-outstanding.
 * - `./journal.js`'s `evaluationGaps` DOES return it as a gap, but the resume path in
 *   `../operations/run-launch.js` dropped every gap whose `deliverySha256` was undefined, and the
 *   lost `delivery` entry is exactly what carries `deliverySha256`. Resume was a permanent no-op.
 * - `../operations/run-collect.js` computes `allTerminalAccounted` from the UNFILTERED
 *   `evaluationGaps`, so collect refuses ("resume the run or wait for the close boundary") until
 *   `closeAt` — pointing back at a resume that can never clear it.
 *
 * The durable truth survives the crash: the venue attempt directory still holds the sealed
 * Delivery and its outputs, and the delivered cell-event's own `attempt` URI is in the fold. The
 * cure re-enters the harvest path from that attempt, byte-exactly — the sealed Delivery is
 * re-read, never re-minted — and dispatches only the missing evaluation legs.
 *
 * The interruption technique (modelled on `./run-resume-evaluation-replay.integration.test.ts`,
 * and on commit 4baca1909's lesson that a crash shim must let the real backend read settle before
 * it abandons, or the crash point moves under whole-suite parallelism): a backend shim under the
 * recording proxy lets the FIRST `fetchDelivery` complete for real — proving the Delivery is
 * durably readable through the backend — and then never resolves. `launchAndWatch` never calls
 * `fetchDelivery` itself (`packages/benchmarking/run/src/launch.ts`), and `driveCellEvents`
 * processes events serially, so that first call is unambiguously the solve-side harvest of the
 * first delivered cell. The drive is abandoned there, so nothing is ever journaled for that
 * cell beyond its `delivered` cell-event. Nothing is hand-written into the journal.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseBenchmark, parseMatrix, parseRun } from "@jinn-network/benchmarking-records";
import { launchAndWatch } from "@jinn-network/benchmarking-run";
import { armAdd } from "../operations/arms.js";
import type { OperationContext } from "../operations/context.js";
import { createDraft, readDraftDocument } from "../operations/drafts.js";
import { initWorkspace } from "../operations/init.js";
import { runCollect } from "../operations/run-collect.js";
import { runLock } from "../operations/run-lock.js";
import { runQuote } from "../operations/run-quote.js";
import { runResume } from "../operations/run-launch.js";
import { sampleInit } from "../operations/sample.js";
import { createLocalVenue, SOLVE_HARNESS_PINS, type LocalVenue } from "../venue/venue.js";
import { atomicWriteFileSync } from "../fs/atomic.js";
import { draftPath } from "../workspace/layout.js";
import { getSealedBytes } from "../workspace/sealed-store.js";
import { transition } from "../domain/lifecycle.js";
import { createRecordingProxy, driveCellEvents, type DriveDeps, type ProxiedBackend } from "./drive.js";
import {
  appendRunJournalEntry,
  evaluationGaps,
  foldRunJournal,
  readRunJournalEntries,
  type RunJournalEntry,
} from "./journal.js";
import { requireRunState, writeRunState } from "./state.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "stranded-delivery-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

/** Real wall clock — see `./run-resume.integration.test.ts`'s note on why a frozen clock breaks
 * the real supervisor's own deadline checks. */
function makeClock(): () => string {
  return () => new Date().toISOString();
}

function contextFor(clock: () => string, principal = "sponsor-1"): OperationContext {
  return { workspaceDir, principal, clock };
}

async function setUpLockedDraft(clock: () => string, draftId: string): Promise<void> {
  expect(initWorkspace(contextFor(clock)).ok).toBe(true);
  expect(createDraft(contextFor(clock), { draftId, name: "Stranded Delivery" }).ok).toBe(true);
  expect((await sampleInit(contextFor(clock), { draftId })).ok).toBe(true);
  expect(armAdd(contextFor(clock), {
    draftId,
    armId: "baseline",
    pinning: { harness: SOLVE_HARNESS_PINS["prediction-v1-baseline"] },
  }).ok).toBe(true);
  expect(armAdd(contextFor(clock), {
    draftId,
    armId: "sample-uniform",
    pinning: { harness: SOLVE_HARNESS_PINS["sample-uniform"] },
  }).ok).toBe(true);
  expect((await runQuote(contextFor(clock), { draftId })).ok).toBe(true);
  expect(runLock(contextFor(clock), { draftId }).ok).toBe(true);
}

interface CrashState {
  fired: boolean;
  deliverySha256?: string;
  resolve?: () => void;
}

/**
 * Delegates every `ProxiedBackend` method to the real venue backend, except that the first
 * `fetchDelivery` — the solve-side harvest of the first delivered cell (module header) — completes
 * for real and then never resolves, so the `delivery` journal entry that would have followed is
 * never written.
 */
function hangBeforeDeliveryJournal(backend: ProxiedBackend, crash: CrashState): ProxiedBackend {
  return {
    capabilities: () => backend.capabilities(),
    submit: (taskBytes, submissionBytes, engagement) =>
      backend.submit(taskBytes, submissionBytes, engagement),
    observe: (ref) => backend.observe(ref),
    ...(backend.watch === undefined ? {} : { watch: (ref, cursor) => backend.watch!(ref, cursor) }),
    ...(backend.cancel === undefined ? {} : { cancel: (a, r) => backend.cancel!(a, r) }),
    recover: (ref) => backend.recover(ref),
    deliveries: (attempt) => backend.deliveries(attempt),
    fetchDelivery: async (ref) => {
      if (crash.fired) return new Promise<Uint8Array>(() => {});
      // Let the real read complete first (commit 4baca1909's lesson): that proves the Delivery is
      // durably readable THROUGH the backend before the drive is abandoned and the venue is shut
      // down, so the crash point is exactly "after the delivered cell-event, before the delivery
      // journal write" rather than "somewhere around the backend's own delivery write".
      const bytes = await backend.fetchDelivery(ref);
      crash.fired = true;
      crash.deliverySha256 = createHash("sha256").update(bytes).digest("hex");
      crash.resolve?.();
      return new Promise<Uint8Array>(() => {});
    },
    ...(backend.fetchArtifact === undefined
      ? {}
      : { fetchArtifact: (d) => backend.fetchArtifact!(d) }),
    ...(backend.pinningEvidenceForSubmission === undefined
      ? {}
      : { pinningEvidenceForSubmission: (ref) => backend.pinningEvidenceForSubmission!(ref) }),
    drain: () => backend.drain(),
  };
}

/**
 * Mirrors `runLaunch`'s own `run` closure (advance locked->running, stamp launchedAt, journal
 * "launched", boot the real venue, drive `launchAndWatch`) and abandons the drive the moment the
 * first solve Delivery has been read but not yet journaled.
 */
async function driveUntilDeliveryUnjournaled(clock: () => string, draftId: string): Promise<CrashState> {
  const at = clock();
  const document = readDraftDocument(workspaceDir, draftId);
  const transitioned = transition("locked", "launch");
  if (!transitioned.ok) throw new Error("unreachable");
  atomicWriteFileSync(
    draftPath(workspaceDir, draftId),
    JSON.stringify({ ...document, state: transitioned.state, updatedAt: at }, null, 2),
  );

  const runState = requireRunState(workspaceDir, draftId);
  if (runState.runSha256 === undefined) throw new Error("unreachable");
  writeRunState(workspaceDir, draftId, { ...runState, launchedAt: at });
  appendRunJournalEntry(workspaceDir, draftId, { kind: "launched", at: clock() });

  const runRecord = parseRun(getSealedBytes(workspaceDir, runState.runSha256));
  if (document.spec.taskSet.kind !== "benchmark") throw new Error("unreachable: no benchmark");
  const benchRecord = parseBenchmark(getSealedBytes(workspaceDir, document.spec.taskSet.benchmarkSha256));

  const venue: LocalVenue = createLocalVenue({ workspaceDir, now: clock });
  const crash: CrashState = { fired: false };
  const stranded = new Promise<void>((resolve) => {
    crash.resolve = resolve;
  });
  try {
    const backend = createRecordingProxy(
      hangBeforeDeliveryJournal(venue.backend, crash),
      { workspaceDir, draftId, liveClock: clock },
    );
    const driveDeps: DriveDeps = {
      workspaceDir,
      draftId,
      venue,
      backend,
      runSha256: runState.runSha256,
      owner: runState.owner,
      cellWindowMs: runRecord.policy.cellWindow,
      minVerdicts: runRecord.policy.evaluation?.minVerdicts ?? 1,
      liveClock: clock,
    };
    const events = launchAndWatch(benchRecord, runRecord, backend, {
      runDigest: `sha256:${runState.runSha256}`,
      taskBytesFor: (taskDigestHex) => getSealedBytes(workspaceDir, taskDigestHex),
      clock: { now: () => new Date(clock()) },
    });

    // The drive is ABANDONED, never awaited to completion: the injected hang holds it inside
    // `driveEvaluationForDelivery` between the delivered cell-event's journal write and the
    // delivery entry's.
    const abandoned = driveCellEvents(driveDeps, events);
    abandoned.catch(() => undefined);
    await stranded;
  } finally {
    await venue.shutdown();
  }
  return crash;
}

function deliveryEntriesFor(entries: readonly RunJournalEntry[], cellKey: string) {
  return entries.filter(
    (entry): entry is Extract<RunJournalEntry, { kind: "delivery" }> =>
      entry.kind === "delivery" && entry.cellKey === cellKey,
  );
}

function evaluationEntriesFor(entries: readonly RunJournalEntry[], cellKey: string) {
  return entries.filter(
    (entry): entry is Extract<RunJournalEntry, { kind: "evaluation" }> =>
      entry.kind === "evaluation" && entry.cellKey === cellKey,
  );
}

describe("resume heals a cell stranded between its delivered cell-event and its delivery record", () => {
  test(
    "the stranded cell reaches a verdict byte-exactly and collect proceeds before closeAt",
    async () => {
      const clock = makeClock();
      const draftId = "draft-stranded";
      await setUpLockedDraft(clock, draftId);

      const crash = await driveUntilDeliveryUnjournaled(clock, draftId);
      expect(
        crash.deliverySha256,
        "the interruption never fired on a solve-side Delivery read",
      ).toMatch(/^[0-9a-f]{64}$/u);

      // ── the interrupted state is exactly the canary's stranded shape ─────────────────────
      const interrupted = readRunJournalEntries(workspaceDir, draftId);
      const deliveredEvents = interrupted.filter(
        (entry): entry is Extract<RunJournalEntry, { kind: "cell-event" }> =>
          entry.kind === "cell-event" && entry.event.kind === "delivered",
      );
      expect(deliveredEvents, "exactly one cell should have delivered before the crash").toHaveLength(1);
      const strandedCellKey = deliveredEvents[0]!.event.cellKey;
      const strandedAttempt = deliveredEvents[0]!.event.attempt;
      expect(strandedAttempt, "the delivered cell-event carried no attempt reference").toBeDefined();
      // The two writes that the crash window sits between: the first landed, the second did not.
      expect(interrupted.filter((entry) => entry.kind === "delivery")).toEqual([]);
      expect(interrupted.filter((entry) => entry.kind === "evaluation")).toEqual([]);
      // The fold agrees: delivered, therefore not solve-outstanding, and a gap with no delivery.
      const interruptedFold = foldRunJournal(interrupted);
      expect(interruptedFold.get(strandedCellKey)?.status).toBe("delivered");
      expect(interruptedFold.get(strandedCellKey)?.deliverySha256).toBeUndefined();
      expect(interruptedFold.get(strandedCellKey)?.attempt).toBe(strandedAttempt);

      // ── resume through the PUBLIC operation, on a fresh venue ────────────────────────────
      const resumed = await runResume(contextFor(clock), { draftId, maxConcurrentCells: 4 });
      expect(resumed.ok, JSON.stringify(resumed)).toBe(true);

      const afterResume = readRunJournalEntries(workspaceDir, draftId);

      // ── a second resume reports nothing left to do ───────────────────────────────────────
      // Before the fix this is the canary's exact observation: the gap is silently dropped, so
      // resume says there is nothing outstanding and nothing to catch up while the cell has no
      // terminal at all. After the fix it says the same thing for the honest reason — the first
      // resume already healed it. Either way the next two assertions are what separate them.
      const resumedAgain = await runResume(contextFor(clock), { draftId, maxConcurrentCells: 4 });
      expect(resumedAgain.ok, JSON.stringify(resumedAgain)).toBe(true);
      if (!resumedAgain.ok) throw new Error("unreachable");
      expect(resumedAgain.result).toEqual({ outstandingCount: 0, evaluationCatchUpCount: 0 });
      const afterSecondResume = readRunJournalEntries(workspaceDir, draftId);

      // ── resume and collect agree: no gaps left, so collect does not wait for closeAt ─────
      const closeAt = requireRunState(workspaceDir, draftId).closeAt;
      expect(closeAt).toBeDefined();
      expect(
        Date.now() < Date.parse(closeAt!),
        "the close boundary already passed — collect would have proceeded regardless",
      ).toBe(true);

      // The deadlock surfaces here: `run-collect.ts` reads the UNFILTERED `evaluationGaps`, so the
      // gap resume dropped still makes collect refuse — "resume the run or wait for the close
      // boundary" — pointing back at a resume that just reported nothing to do.
      const collected = await runCollect(contextFor(clock), { draftId });
      expect(collected.ok, JSON.stringify(collected)).toBe(true);
      if (!collected.ok) throw new Error("unreachable");
      expect(evaluationGaps(foldRunJournal(afterSecondResume), 1, 0)).toEqual([]);

      // ── the stranded cell healed byte-exactly, and only once ────────────────────────────
      const healedDelivery = deliveryEntriesFor(afterResume, strandedCellKey);
      expect(
        healedDelivery.length,
        "resume left the stranded cell with no delivery record — its evaluation gap was dropped "
        + "because the lost journal entry is the one that carried deliverySha256",
      ).toBe(1);
      expect(healedDelivery[0]?.attempt).toBe(strandedAttempt);
      // Byte-exact: the SAME Delivery bytes the backend served before the crash, re-read from the
      // attempt's durable state and re-sealed content-addressed. Never re-minted.
      expect(healedDelivery[0]?.deliverySha256).toBe(crash.deliverySha256);

      const healedEvaluation = evaluationEntriesFor(afterResume, strandedCellKey);
      expect(healedEvaluation, "the stranded cell reached no evaluation terminal").toHaveLength(1);
      expect(healedEvaluation[0]?.evaluationTerminal).toBeUndefined();
      expect(healedEvaluation[0]?.verdictSha256).toBeDefined();

      // The solve leg was never re-driven: still exactly one delivered cell-event for that cell.
      expect(
        afterResume.filter(
          (entry) => entry.kind === "cell-event"
            && entry.event.cellKey === strandedCellKey
            && entry.event.kind === "delivered",
        ),
      ).toHaveLength(1);

      // The second resume wrote nothing further for it: repeated resumes converge.
      expect(deliveryEntriesFor(afterSecondResume, strandedCellKey)).toEqual(healedDelivery);
      expect(evaluationEntriesFor(afterSecondResume, strandedCellKey)).toEqual(healedEvaluation);

      const matrix = parseMatrix(getSealedBytes(workspaceDir, collected.result.matrixSha256));
      for (const cell of matrix.cells) expect(cell.outcome, cell.cellKey).toBe("judged");
      expect(matrix.completeness).toMatchObject({
        expected: matrix.cells.length,
        judged: matrix.cells.length,
        runOutcome: "complete",
      });
    },
    240_000,
  );
});
