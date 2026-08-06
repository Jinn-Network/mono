/**
 * AC4 — interruption/resume on the real local venue (BP-12, M1 composition dossier). Drives the
 * INTERRUPTION half directly through this module's own internal driver seam (`./drive.js`'s
 * `createRecordingProxy` + `driveCellEvents`, composed exactly the way `../operations/run-launch.js`'s
 * `runLaunch` composes them — see that file's own `run` closure) because the public `runLaunch`
 * operation exposes no event-level injection point; the RESUME half then goes through the public
 * `runResume` operation unmodified, per the packet brief.
 *
 * The interruption technique: wrap the `CellStatusEvent` stream `launchAndWatch` yields so that,
 * once it has yielded a solve-side "delivered" event AND the driver has fully processed it
 * (including dispatching and completing that cell's evaluation leg — `../run/drive.js`'s
 * `driveCellEvents` awaits `driveEvaluationForDelivery` before asking the stream for its next
 * event), the wrapper throws instead of yielding anything further. `launchAndWatch` dispatches
 * cells strictly sequentially (`packages/benchmarking/run/src/launch.ts`'s `for (const coord of
 * cells)`), so this reliably interrupts after exactly one cell has fully completed (delivered +
 * judged) and before any other cell's dispatch has even started — a faithful "the process was
 * killed right here" simulation, not a scripted fake.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  parseBenchmark,
  parseMatrix,
  parseRun,
} from "@jinn-network/benchmarking-records";
import { launchAndWatch, type CellStatusEvent } from "@jinn-network/benchmarking-run";
import { armAdd } from "../operations/arms.js";
import type { OperationContext } from "../operations/context.js";
import { createDraft, readDraftDocument } from "../operations/drafts.js";
import { initWorkspace } from "../operations/init.js";
import { runCollect } from "../operations/run-collect.js";
import { runLock } from "../operations/run-lock.js";
import { runQuote } from "../operations/run-quote.js";
import { runResults } from "../operations/run-results.js";
import { runResume } from "../operations/run-launch.js";
import { sampleInit } from "../operations/sample.js";
import { createLocalVenue, SOLVE_HARNESS_PINS, EVALUATION_HARNESS_PIN, type LocalVenue } from "../venue/venue.js";
import { atomicWriteFileSync } from "../fs/atomic.js";
import { draftPath } from "../workspace/layout.js";
import { getSealedBytes } from "../workspace/sealed-store.js";
import { transition } from "../domain/lifecycle.js";
import { createRecordingProxy, driveCellEvents, type DriveDeps } from "./drive.js";
import { appendRunJournalEntry, foldRunJournal, readRunJournalEntries, type RunJournalEntry } from "./journal.js";
import { requireRunState, writeRunState } from "./state.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bp12-run-resume-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

/**
 * The REAL wall clock (see `./run-path.integration.test.ts`'s own note): this test drives the
 * real local venue's real subprocess supervisor both for the interrupted launch and for the
 * public `runResume`, and a synthetic clock rooted at a fixed past instant makes every real
 * attempt's deadline look already-expired against the supervisor's own wall-clock checks.
 */
function makeClock(): () => string {
  return () => new Date().toISOString();
}

function contextFor(clock: () => string, principal = "sponsor-1"): OperationContext {
  return { workspaceDir, principal, clock };
}

async function setUpLockedTwoArmDraft(clock: () => string, draftId: string): Promise<void> {
  const initialized = initWorkspace(contextFor(clock));
  expect(initialized.ok).toBe(true);
  const created = createDraft(contextFor(clock), { draftId, name: "Resume Test" });
  expect(created.ok).toBe(true);
  const sample = await sampleInit(contextFor(clock), { draftId });
  expect(sample.ok).toBe(true);
  const baselineArm = armAdd(contextFor(clock), {
    draftId,
    armId: "baseline",
    pinning: { harness: SOLVE_HARNESS_PINS["prediction-v1-baseline"] },
  });
  expect(baselineArm.ok).toBe(true);
  const sampleArm = armAdd(contextFor(clock), {
    draftId,
    armId: "sample-uniform",
    pinning: { harness: SOLVE_HARNESS_PINS["sample-uniform"] },
  });
  expect(sampleArm.ok).toBe(true);
  const quoted = await runQuote(contextFor(clock), { draftId });
  expect(quoted.ok).toBe(true);
  // sponsor-1 is the founding sponsor (initWorkspace) and holds every gated grant by default —
  // "grants as needed" is already satisfied without an explicit authorityGrant call here (AC5's
  // gating behavior is covered end to end by ./run-path.integration.test.ts).
  const locked = runLock(contextFor(clock), { draftId });
  expect(locked.ok).toBe(true);
}

const INTERRUPT_MARKER = "bp12-simulated-crash-after-first-delivered-cell";

/**
 * Wraps a `CellStatusEvent` stream so that, once a solve-side "delivered" event has been yielded
 * AND fully processed by the consumer (`driveCellEvents` awaits the whole evaluation leg before
 * asking for the next event — see module header), the very next request throws instead of
 * yielding anything further. Never touches the underlying `launchAndWatch` generator again once
 * that happens — the abandoned cells are never even dispatched, exactly simulating a process
 * killed between one cell's full completion and the next cell's dispatch.
 */
async function* interruptAfterFirstDelivered(
  events: AsyncIterable<CellStatusEvent>,
): AsyncGenerator<CellStatusEvent> {
  for await (const event of events) {
    yield event;
    if (event.kind === "delivered") {
      throw new Error(INTERRUPT_MARKER);
    }
  }
}

/**
 * Drives the interruption half directly (module header): mirrors exactly what
 * `../operations/run-launch.js`'s `runLaunch` does in its `run` closure — advance locked->running,
 * stamp `RunState.launchedAt`, journal "launched", boot the real local venue, and drive
 * `launchAndWatch`'s events through `driveCellEvents` — except the event stream is wrapped with
 * `interruptAfterFirstDelivered` so the drive is guaranteed to stop partway through.
 */
async function driveInterruptedLaunch(clock: () => string, draftId: string): Promise<void> {
  const at = clock();
  const document = readDraftDocument(workspaceDir, draftId);
  expect(document.state).toBe("locked");

  const transitioned = transition("locked", "launch");
  expect(transitioned.ok).toBe(true);
  if (!transitioned.ok) throw new Error("unreachable");
  atomicWriteFileSync(
    draftPath(workspaceDir, draftId),
    JSON.stringify({ ...document, state: transitioned.state, updatedAt: at }, null, 2),
  );

  const runState = requireRunState(workspaceDir, draftId);
  expect(runState.runSha256).toBeDefined();
  if (runState.runSha256 === undefined) throw new Error("unreachable");
  writeRunState(workspaceDir, draftId, { ...runState, launchedAt: at });

  appendRunJournalEntry(workspaceDir, draftId, { kind: "launched", at: clock() });

  const runRecord = parseRun(getSealedBytes(workspaceDir, runState.runSha256));
  if (document.spec.taskSet.kind !== "benchmark") throw new Error("unreachable: no attached benchmark");
  const benchRecord = parseBenchmark(getSealedBytes(workspaceDir, document.spec.taskSet.benchmarkSha256));

  const venue: LocalVenue = createLocalVenue({ workspaceDir, now: clock });
  let sawInjectedInterruption = false;
  try {
    const backend = createRecordingProxy(venue.backend, { workspaceDir, draftId, liveClock: clock });
    const driveDeps: DriveDeps = {
      workspaceDir,
      draftId,
      venue,
      backend,
      runSha256: runState.runSha256,
      owner: runState.owner,
      cellWindowMs: runRecord.policy.cellWindow,
      liveClock: clock,
    };

    const events = launchAndWatch(benchRecord, runRecord, backend, {
      runDigest: `sha256:${runState.runSha256}`,
      taskBytesFor: (taskDigestHex) => getSealedBytes(workspaceDir, taskDigestHex),
      clock: { now: () => new Date(clock()) },
    });

    try {
      await driveCellEvents(driveDeps, interruptAfterFirstDelivered(events));
    } catch (cause) {
      if (cause instanceof Error && cause.message === INTERRUPT_MARKER) {
        sawInjectedInterruption = true;
      } else {
        throw cause;
      }
    }
  } finally {
    await venue.shutdown();
  }

  expect(
    sawInjectedInterruption,
    "the drive completed without the injected interruption ever firing — " +
      "interruptAfterFirstDelivered's trigger condition needs investigation",
  ).toBe(true);
}

/** Reads a stored solve or evaluation Submission's harness id (undefined if unreadable). */
function harnessIdOf(sha256: string): string | undefined {
  const bytes = getSealedBytes(workspaceDir, sha256);
  const doc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as {
    readonly requirements?: { readonly harness?: { readonly id?: string } };
    readonly idempotencyKey?: string;
  };
  return doc.requirements?.harness?.id;
}

function idempotencyKeyOf(sha256: string): string | undefined {
  const bytes = getSealedBytes(workspaceDir, sha256);
  const doc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as {
    readonly idempotencyKey?: string;
  };
  return doc.idempotencyKey;
}

describe("interruption / resume on the real local venue (AC4)", () => {
  test(
    "an interrupted launch resumes cleanly via the public runResume, with no double-posted cell",
    async () => {
      const clock = makeClock();
      const draftId = "draft-1";

      await setUpLockedTwoArmDraft(clock, draftId);

      // ── interrupt after exactly one cell has fully completed ───────────────────────────
      await driveInterruptedLaunch(clock, draftId);

      expect(readDraftDocument(workspaceDir, draftId).state).toBe("running");
      const interruptedEntries = readRunJournalEntries(workspaceDir, draftId);
      expect(interruptedEntries[0]).toMatchObject({ kind: "launched" });
      const interruptedFold = foldRunJournal(interruptedEntries);
      // Exactly one cell has any journal coverage at all — partial cell coverage, not zero and
      // not all six.
      expect(interruptedFold.size).toBe(1);
      const [completedCellKey] = [...interruptedFold.keys()];
      expect(completedCellKey).toBeDefined();
      if (completedCellKey === undefined) throw new Error("unreachable");
      expect(interruptedFold.get(completedCellKey)?.status).toBe("judged");

      const evaluationEntriesBeforeResume = interruptedEntries.filter(
        (entry): entry is Extract<RunJournalEntry, { kind: "evaluation" }> => entry.kind === "evaluation",
      );
      expect(evaluationEntriesBeforeResume).toHaveLength(1);
      expect(evaluationEntriesBeforeResume[0]?.verdictSha256).toBeDefined();

      // ── resume through the PUBLIC operation, real venue (no injected deps) ──────────────
      const resumed = await runResume(contextFor(clock), { draftId });
      expect(resumed.ok).toBe(true);
      if (!resumed.ok) throw new Error("unreachable");
      expect(resumed.result.outstandingCount).toBe(5);
      expect(resumed.result.evaluationCatchUpCount).toBe(0);

      // ── every cell reaches judged; the run completes cleanly from here ─────────────────
      const collected = await runCollect(contextFor(clock), { draftId });
      expect(collected.ok).toBe(true);
      if (!collected.ok) throw new Error("unreachable");
      const matrix = parseMatrix(getSealedBytes(workspaceDir, collected.result.matrixSha256));
      expect(matrix.cells).toHaveLength(6);
      for (const cell of matrix.cells) {
        expect(cell.outcome, cell.cellKey).toBe("judged");
      }
      expect(matrix.completeness).toMatchObject({ expected: 6, judged: 6, runOutcome: "complete" });

      const results = runResults(contextFor(clock), { draftId });
      expect(results.ok).toBe(true);
      if (!results.ok) throw new Error("unreachable");
      expect(results.result.runOutcome).toBe("complete");
      expect(results.result.completeness).toMatchObject({ expected: 6, judged: 6 });

      // ── idempotency (the packet's binary criterion): no cell was double-posted ──────────
      const finalEntries = readRunJournalEntries(workspaceDir, draftId);
      const submissionAcceptedEntries = finalEntries.filter(
        (entry): entry is Extract<RunJournalEntry, { kind: "submission-accepted" }> =>
          entry.kind === "submission-accepted",
      );

      const solveEntries = submissionAcceptedEntries.filter(
        (entry) => harnessIdOf(entry.submissionSha256) !== EVALUATION_HARNESS_PIN.id,
      );
      const evalEntries = submissionAcceptedEntries.filter(
        (entry) => harnessIdOf(entry.submissionSha256) === EVALUATION_HARNESS_PIN.id,
      );

      // Exactly 6 solve submissions total across launch + resume — one per expected cell.
      expect(solveEntries).toHaveLength(6);

      // Every cellKey has EXACTLY ONE solve submission-accepted entry: no cell — including the
      // one that completed before the crash — was ever double-posted across launch + resume.
      const solveCountByCellKey = new Map<string, number>();
      for (const entry of solveEntries) {
        solveCountByCellKey.set(entry.cellKey, (solveCountByCellKey.get(entry.cellKey) ?? 0) + 1);
      }
      expect(solveCountByCellKey.size).toBe(6);
      for (const [cellKey, count] of solveCountByCellKey) {
        expect(count, cellKey).toBe(1);
      }
      // The cell that completed before the crash in particular: exactly one solve submission.
      expect(solveCountByCellKey.get(completedCellKey)).toBe(1);

      // Every eval idempotency key appears exactly once — no re-posted evaluation Submission.
      expect(evalEntries).toHaveLength(6);
      const evalIdempotencyKeys = evalEntries.map((entry) => idempotencyKeyOf(entry.submissionSha256));
      expect(evalIdempotencyKeys.every((key) => typeof key === "string" && key.length > 0)).toBe(true);
      expect(new Set(evalIdempotencyKeys).size).toBe(evalEntries.length);
    },
    240_000,
  );
});
