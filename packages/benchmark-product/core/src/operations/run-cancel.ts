/**
 * `run.cancel` (spec §4.1: running --cancel--> closed, GATED; BP-22 plan decision 4): stops a
 * running run's dispatch, drains it to a boundary, and seals the Matrix with the cancellation
 * accounted. Two-phase because a run may be actively driven by a live `launch`/`resume` call
 * (in another process, or another async context in this one) holding the local venue's own
 * state-root writer lock (`../venue/venue.ts`'s `createLocalVenue` composes
 * `@jinn-network/task-execution-backend-local`'s single-writer-per-state-root discipline):
 *
 * - The cancel MARKER (`../run/cancel-marker.ts`) is written FIRST, before any other effect —
 *   durable, permanent proof the run was asked to stop, independent of whether this call (or any
 *   call) ever gets to finalize it. `../run/assembly-ports.ts` derives
 *   `completeness.runOutcome: "cancelled"` from the valid marker, so once it is
 *   written every later `run.verify` agrees the run was cancelled, even if this call crashes
 *   right after writing it.
 * - This call then PROBES the venue (`venue.backend.preflight({})`) to find out whether a live
 *   driver currently holds the writer lock. `createLocalVenue` itself always succeeds (the
 *   writer lock is only asserted inside individual backend methods); `preflight` is the
 *   read-only method that surfaces a busy/unavailable venue by throwing. If EITHER `createVenue`
 *   or the probe throws, this call cannot safely finalize — a live driver could still be
 *   mid-dispatch, and finalizing now would race it. Phase `"requested"` is returned instead: the
 *   cancellation IS recorded (the marker is already durable), and the live driver's own
 *   `earlyClose` getter (`../operations/run-launch.ts`) picks up the marker at its next cell
 *   boundary and stops dispatch. The operator re-runs `cancel` once the driver has exited.
 * - Once the venue is free, this call HOLDS it for the entire finalize (drain the outstanding
 *   cells, assemble, verify, transition, seal) — so no `launch`/`resume` can boot mid-finalize.
 *   Phase `"cancelled"` is the terminal, successful result.
 *
 * The drain itself calls `resumeRun` with `earlyClose: true` and passes `venue.backend` directly
 * (never `../run/drive.ts`'s recording proxy or `driveCellEvents`): with `earlyClose: true`,
 * `resumeRun` checks its own owner-cancelled gate BEFORE touching the backend for each
 * outstanding cell, so it never actually dispatches anything — every outstanding cell (including
 * one never dispatched at all) yields a `"cancelled"` terminal without a single backend call.
 * There is deliberately no evaluation catch-up here: cancel stops spending immediately. A cell
 * that was delivered but never reached a verdict before the marker landed is drained untouched
 * and assembles as `"unjudged"` (design §8.2) — accounted, never silently dropped.
 *
 * Idempotent in both phases: a cancel against an already-`running` draft with a marker already
 * present skips re-writing the marker, then independently repairs the journal's
 * `cancel-requested` echo if an interruption landed between those two writes (and otherwise
 * skips it, preserving exactly one per run). Once cancellation has finalized, repeating
 * `cancel` returns the exact already-sealed Matrix result without acquiring a venue or appending
 * another journal entry. A naturally collected (non-cancelled) closed run still refuses
 * `"illegal-transition"`.
 *
 * Finalization is crash-safe: every replayable/fallible write (sealed Matrix, RunState, and the
 * deduplicated `closed` journal entry) lands before the irreversible running→closed draft write.
 * A retry after any earlier interruption re-derives the same Matrix and fills whichever write
 * was missing; once the draft says closed, all artifacts it names already exist.
 */

import {
  expectedCellSet,
  parseBenchmark,
  parseMatrix,
  parseRun,
} from "@jinn-network/benchmarking-records";
import { assembleMatrix, resumeRun, verifyMatrix } from "@jinn-network/benchmarking-run";
import { TaskExecutionError } from "@jinn-network/task-execution-backend";
import type { DraftDocument } from "../domain/draft.js";
import { transition } from "../domain/lifecycle.js";
import { refuse } from "../errors.js";
import { atomicWriteFileSync } from "../fs/atomic.js";
import { scanPredictionSnapshotAdmissionReceipts } from "../run/admission-receipts.js";
import { buildRunAssemblyPorts } from "../run/assembly-ports.js";
import { cancelRequested, writeCancelMarker } from "../run/cancel-marker.js";
import { acquireRunFinalizationLock } from "../run/finalization-lock.js";
import { appendRunJournalEntry, foldRunJournal, outstandingCells, readRunJournalEntries } from "../run/journal.js";
import { requireRunState, writeRunState } from "../run/state.js";
import { draftPath } from "../workspace/layout.js";
import { getSealedBytes, putSealedBytes } from "../workspace/sealed-store.js";
import { createLocalVenue, type LocalVenue } from "../venue/venue.js";
import type { OperationContext } from "./context.js";
import { readDraftDocument } from "./drafts.js";
import { operateAsync } from "./operate-async.js";
import type { OperationResult } from "./result.js";

export interface RunCancelDeps {
  readonly createVenue?: typeof createLocalVenue;
}

export interface RunCancelInput {
  readonly draftId: string;
}

function taskExecutionErrorAcrossPortalBoundary(cause: unknown): TaskExecutionError | undefined {
  if (cause instanceof TaskExecutionError) return cause;
  if (
    cause instanceof Error
    && cause.name === "TaskExecutionError"
    && "category" in cause
    && typeof cause.category === "string"
    && "retryable" in cause
    && typeof cause.retryable === "boolean"
  ) {
    // An isolated portal consumer can load the backend contract through more than one ESM
    // identity. Preserve the contract's typed fields across that packaging boundary instead of
    // treating a genuine operational error as an unrelated exception solely because instanceof
    // observes the constructor copy rather than the public shape.
    return cause as TaskExecutionError;
  }
  return undefined;
}

export type RunCancelResult =
  | {
    /** A live driver or another finalizer owns the relevant single-writer boundary. */
    readonly phase: "requested";
    readonly reason: "venue-contention" | "finalization-contention";
    /** Diagnostic detail only; callers branch on `reason`, never this prose. */
    readonly detail: string;
  }
  | {
    /** The venue was free: outstanding cells were drained, the Matrix was sealed with the
     * cancellation accounted, and the draft transitioned to "closed". */
    readonly phase: "cancelled";
    readonly draft: DraftDocument;
    readonly matrixSha256: string;
  };

function taskBytesForFactory(workspaceDir: string): (taskDigestHex: string) => Uint8Array {
  return (taskDigestHex) => getSealedBytes(workspaceDir, taskDigestHex);
}

/**
 * Creates the venue and probes it for a live writer (module header). Returns the usable venue on
 * success; on ANY throw from either step, best-effort shuts down a venue that was constructed
 * (there is nothing to unwind if construction itself failed) and reports the failure detail —
 * never re-throws, since "the venue is busy" is an expected, recorded outcome here, not an error.
 */
async function acquireFreeVenue(
  createVenue: typeof createLocalVenue,
  workspaceDir: string,
  now: () => string,
  evaluatorCount: number,
): Promise<
  | { readonly ok: true; readonly venue: LocalVenue }
  | { readonly ok: false; readonly reason: "contention" | "unavailable"; readonly detail: string }
> {
  let venue: LocalVenue | undefined;
  try {
    venue = createVenue({ workspaceDir, now, evaluatorCount });
    const preflight = await venue.backend.preflight({});
    if (!preflight.ready) {
      const detail = preflight.detail ?? preflight.error?.message ?? "local venue is not ready";
      await venue.shutdown();
      return { ok: false, reason: "unavailable", detail };
    }
    return { ok: true, venue };
  } catch (cause) {
    if (venue !== undefined) {
      try {
        await venue.shutdown();
      } catch {
        // Best-effort: the venue never became usable, so there is nothing more to unwind.
      }
    }
    const taskExecutionError = taskExecutionErrorAcrossPortalBoundary(cause);
    const contention = taskExecutionError?.category === "backend-unavailable"
      && taskExecutionError.annotations?.["reason"] === "state-root-locked";
    return {
      ok: false,
      reason: contention ? "contention" : "unavailable",
      detail: taskExecutionError !== undefined
        ? taskExecutionError.detail ?? taskExecutionError.message
        : cause instanceof Error
          ? cause.message
          : String(cause),
    };
  }
}

export function runCancel(
  context: OperationContext,
  input: RunCancelInput,
  deps: RunCancelDeps = {},
): Promise<OperationResult<RunCancelResult>> {
  const at = context.clock();
  const clockedContext: OperationContext = { ...context, clock: () => at };
  const createVenue = deps.createVenue ?? createLocalVenue;

  return operateAsync({
    context: clockedContext,
    action: "cancel",
    subject: input.draftId,
    inputs: input,
    run: async () => {
      const finalization = acquireRunFinalizationLock(clockedContext.workspaceDir, input.draftId);
      if (!finalization.acquired) {
        if (finalization.reason === "contended") {
          if (cancelRequested(clockedContext.workspaceDir, input.draftId)) {
            return {
              phase: "requested",
              reason: "finalization-contention",
              detail: finalization.detail,
            };
          }
          refuse(
            "conflict",
            `runs.${input.draftId}.finalization`,
            `${finalization.detail}; no cancellation intent has been recorded`,
          );
        }
        refuse(
          finalization.reason === "invalid" ? "record-integrity" : "execution",
          `runs.${input.draftId}.finalization`,
          finalization.detail,
        );
      }

      try {
        const document = readDraftDocument(clockedContext.workspaceDir, input.draftId);
        const alreadyRequested = cancelRequested(clockedContext.workspaceDir, input.draftId);

      // Terminal idempotency: once THIS operation has closed the run, return its exact durable
      // result. Marker + Matrix together distinguish it from a naturally collected closed run.
      if (document.state === "closed" && alreadyRequested) {
        const terminalState = requireRunState(clockedContext.workspaceDir, input.draftId);
        if (terminalState.matrixSha256 === undefined) {
          refuse(
            "record-integrity",
            `runs.${input.draftId}`,
            `draft ${input.draftId} is closed as cancelled but its RunState names no sealed Matrix`,
          );
        }
        // Re-read the bytes through the sealed store so an idempotent success never blesses a
        // missing/tampered Matrix reference.
        const matrix = parseMatrix(getSealedBytes(clockedContext.workspaceDir, terminalState.matrixSha256));
        if (matrix.completeness.runOutcome !== "cancelled") {
          refuse(
            "record-integrity",
            `runs.${input.draftId}`,
            `draft ${input.draftId} has a cancellation marker but its sealed Matrix is not cancelled`,
          );
        }
        return { phase: "cancelled", draft: document, matrixSha256: terminalState.matrixSha256 };
      }
      if (document.state !== "running") {
        refuse(
          "illegal-transition",
          `drafts.${input.draftId}.state`,
          `draft ${input.draftId} is in state "${document.state}" — only a running draft can be cancelled`,
        );
      }
      if (document.spec.taskSet.kind !== "benchmark") {
        refuse("conflict", `drafts.${input.draftId}.taskSet`, `draft ${input.draftId} has no attached benchmark`);
      }

      const runState = requireRunState(clockedContext.workspaceDir, input.draftId);
      if (runState.runSha256 === undefined) {
        refuse("conflict", `runs.${input.draftId}`, `draft ${input.draftId} has no sealed Run record yet`);
      }

      // Write the marker FIRST, before any other effect — exactly once per run.
      if (!alreadyRequested) {
        writeCancelMarker(clockedContext.workspaceDir, input.draftId, { requestedAt: at, principal: context.principal });
      }

      // The journal echo has its OWN idempotency check. A process can die after the atomic marker
      // write but before this append; on retry, valid-marker presence must not suppress repair of the
      // missing echo. Conversely, an ordinary second call sees the existing entry and never
      // duplicates it.
      const entriesBeforeCancel = readRunJournalEntries(clockedContext.workspaceDir, input.draftId);
      if (!entriesBeforeCancel.some((entry) => entry.kind === "cancel-requested")) {
        appendRunJournalEntry(clockedContext.workspaceDir, input.draftId, { kind: "cancel-requested", at });
      }

      const runRecord = parseRun(getSealedBytes(clockedContext.workspaceDir, runState.runSha256));
      const benchRecord = parseBenchmark(getSealedBytes(clockedContext.workspaceDir, document.spec.taskSet.benchmarkSha256));
      // From the SEALED Run record, never the draft — same reasoning as runLaunch/runResume.
      const minVerdicts = runRecord.policy.evaluation?.minVerdicts ?? 1;

      const acquired = await acquireFreeVenue(createVenue, clockedContext.workspaceDir, context.clock, minVerdicts);
      if (!acquired.ok) {
        if (acquired.reason === "contention") {
          return { phase: "requested", reason: "venue-contention", detail: acquired.detail };
        }
        refuse("venue-unavailable", "venue", acquired.detail);
      }
      const venue = acquired.venue;

      try {
        const expected = expectedCellSet(benchRecord, runRecord);
        const preDrainFold = foldRunJournal(readRunJournalEntries(clockedContext.workspaceDir, input.draftId));
        const outstanding = outstandingCells(expected, preDrainFold);

        if (outstanding.length > 0) {
          // `venue.backend` directly, never the recording proxy: with `earlyClose: true`,
          // `resumeRun` never actually contacts the backend for an outstanding cell (module
          // header) — there is nothing here for a recording proxy to intercept.
          const events = resumeRun(benchRecord, runRecord, venue.backend, {
            runDigest: `sha256:${runState.runSha256}`,
            taskBytesFor: taskBytesForFactory(clockedContext.workspaceDir),
            clock: { now: () => new Date(at) },
            outstanding,
            earlyClose: true,
          });
          for await (const event of events) {
            appendRunJournalEntry(clockedContext.workspaceDir, input.draftId, { kind: "cell-event", at, event });
          }
        }

        // Re-fold: picks up whatever the drain just journaled (a no-op re-read when nothing was
        // outstanding) — assembly must see the drain's own cancelled terminals, never the
        // pre-drain fold.
        const finalEntries = readRunJournalEntries(clockedContext.workspaceDir, input.draftId);
        const fold = foldRunJournal(finalEntries);
        const receiptsByTaskDigest = scanPredictionSnapshotAdmissionReceipts(clockedContext.workspaceDir);

        // Built through the SHARED construction (`../run/assembly-ports.ts`) so `run.verify` can
        // rebuild the exact same ports from the exact same durable facts (that module's own
        // header) — including `runCancelled`, which it derives itself from the marker this call
        // just wrote.
        const ports = buildRunAssemblyPorts({
          workspaceDir: clockedContext.workspaceDir,
          draftId: input.draftId,
          runRecord,
          expected,
          fold,
          owner: runState.owner,
          receiptsByTaskDigest,
        });

        const assembled = await assembleMatrix(benchRecord, runRecord, ports);
        const verified = await verifyMatrix(assembled.record, benchRecord, runRecord, ports, undefined, assembled.bytes);
        if (!verified.ok) {
          refuse("record-integrity", "matrix", `${verified.check}: ${verified.detail}`);
        }

        const matrixSha256 = putSealedBytes(clockedContext.workspaceDir, assembled.bytes);

        writeRunState(clockedContext.workspaceDir, input.draftId, { ...runState, matrixSha256, closedAt: at });

        // Fallible append BEFORE the irreversible lifecycle write, and deduplicated so a retry
        // after a crash between these two steps cannot add a second terminal entry.
        const alreadyClosed = finalEntries.some(
          (entry) => entry.kind === "closed" && entry.matrixSha256 === matrixSha256,
        );
        if (!alreadyClosed) {
          appendRunJournalEntry(clockedContext.workspaceDir, input.draftId, { kind: "closed", at, matrixSha256 });
        }

        const transitioned = transition("running", "cancel");
        if (!transitioned.ok) {
          refuse("illegal-transition", `drafts.${input.draftId}.state`, transitioned.error.detail);
        }
        const draft: DraftDocument = { ...document, state: transitioned.state, updatedAt: at };
        atomicWriteFileSync(draftPath(clockedContext.workspaceDir, input.draftId), JSON.stringify(draft, null, 2));

        return { phase: "cancelled", draft, matrixSha256 };
      } finally {
        await venue.shutdown();
      }
      } finally {
        finalization.release();
      }
    },
  });
}
