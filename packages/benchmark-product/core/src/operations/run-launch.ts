/**
 * `launch` (spec §4.1: locked --launch--> running, GATED) and `run.resume` (spec §4.1:
 * running --resume--> running, ungated crash-safe re-entry): both drive the sealed Run record
 * on the local venue through `../run/drive.ts`'s shared driver, so the per-event handling
 * (journal write, delivery harvest, evaluation dispatch) is defined exactly once.
 *
 * `runLaunch` advances the draft to `running` and stamps `RunState.launchedAt` FIRST, then
 * drives — a drive-time failure still leaves the draft `running` with a real, resumable journal
 * behind it (spec §4.1: "crash-safe resumption via the records' cell idempotency keys"), rather
 * than rolling the lifecycle back to `locked` and stranding real progress.
 *
 * `runResume` recomputes the outstanding cell set from the journal (never a package-local
 * memory), re-enters `resumeRun` with the exact previously-accepted Submission bytes for each
 * outstanding dispatch (so the backend's own idempotency dedup — same idempotencyKey, same
 * bytes — reunites with in-flight work instead of minting a conflicting resubmission), and then
 * sweeps for delivered-but-unevaluated cells left over from an earlier interruption.
 */

import {
  expectedCellSet,
  parseBenchmark,
  parseRun,
  type BenchmarkRecord,
  type RunRecord,
} from "@jinn-network/benchmarking-records";
import { launchAndWatch, resumeRun } from "@jinn-network/benchmarking-run";
import type { DraftDocument } from "../domain/draft.js";
import { transition } from "../domain/lifecycle.js";
import { refuse } from "../errors.js";
import { atomicWriteFileSync } from "../fs/atomic.js";
import {
  createRecordingProxy,
  driveCellEvents,
  driveEvaluationCatchUp,
  type DriveDeps,
} from "../run/drive.js";
import {
  appendRunJournalEntry,
  deliveredWithoutEvaluation,
  foldRunJournal,
  outstandingCells,
  readRunJournalEntries,
} from "../run/journal.js";
import { requireRunState, writeRunState } from "../run/state.js";
import { draftPath } from "../workspace/layout.js";
import { getSealedBytes } from "../workspace/sealed-store.js";
import { createLocalVenue, type LocalVenue } from "../venue/venue.js";
import type { OperationContext } from "./context.js";
import { readDraftDocument } from "./drafts.js";
import { operateAsync } from "./operate-async.js";
import type { OperationResult } from "./result.js";

export interface RunLaunchDeps {
  readonly createVenue?: typeof createLocalVenue;
}

export interface RunLaunchInput {
  readonly draftId: string;
}

export interface RunLaunchResult {
  readonly draft: DraftDocument;
}

export interface RunResumeInput {
  readonly draftId: string;
}

export interface RunResumeResult {
  /** Cells re-entered through `resumeRun` this call (in-flight, expired-replaceable, or never-dispatched). */
  readonly outstandingCount: number;
  /** Delivered-but-unevaluated cells whose evaluation leg was re-run this call. */
  readonly evaluationCatchUpCount: number;
}

interface LoadedRun {
  readonly document: DraftDocument;
  readonly benchRecord: BenchmarkRecord;
  readonly runRecord: RunRecord;
  readonly runSha256: string;
  readonly owner: string;
}

function loadLockedOrRunningRun(workspaceDir: string, draftId: string, expectedState: "locked" | "running"): LoadedRun {
  const document = readDraftDocument(workspaceDir, draftId);
  if (document.state !== expectedState) {
    refuse(
      "illegal-transition",
      `drafts.${draftId}.state`,
      `draft ${draftId} is in state "${document.state}" — expected "${expectedState}"`,
    );
  }
  const runState = requireRunState(workspaceDir, draftId);
  if (runState.runSha256 === undefined) {
    refuse("conflict", `runs.${draftId}`, `draft ${draftId} has no sealed Run record yet — lock it first`);
  }
  const runRecord = parseRun(getSealedBytes(workspaceDir, runState.runSha256));
  if (document.spec.taskSet.kind !== "benchmark") {
    refuse("conflict", `drafts.${draftId}.taskSet`, `draft ${draftId} has no attached benchmark`);
  }
  const benchRecord = parseBenchmark(getSealedBytes(workspaceDir, document.spec.taskSet.benchmarkSha256));
  return { document, benchRecord, runRecord, runSha256: runState.runSha256, owner: runState.owner };
}

function taskBytesForFactory(workspaceDir: string): (taskDigestHex: string) => Uint8Array {
  return (taskDigestHex) => getSealedBytes(workspaceDir, taskDigestHex);
}

export function runLaunch(
  context: OperationContext,
  input: RunLaunchInput,
  deps: RunLaunchDeps = {},
): Promise<OperationResult<RunLaunchResult>> {
  const at = context.clock();
  const clockedContext: OperationContext = { ...context, clock: () => at };
  const createVenue = deps.createVenue ?? createLocalVenue;

  return operateAsync({
    context: clockedContext,
    action: "launch",
    subject: input.draftId,
    inputs: input,
    run: async () => {
      const loaded = loadLockedOrRunningRun(clockedContext.workspaceDir, input.draftId, "locked");

      const transitioned = transition("locked", "launch");
      if (!transitioned.ok) {
        refuse("illegal-transition", `drafts.${input.draftId}.state`, transitioned.error.detail);
      }
      const draft: DraftDocument = { ...loaded.document, state: transitioned.state, updatedAt: at };
      atomicWriteFileSync(draftPath(clockedContext.workspaceDir, input.draftId), JSON.stringify(draft, null, 2));

      const runState = requireRunState(clockedContext.workspaceDir, input.draftId);
      writeRunState(clockedContext.workspaceDir, input.draftId, { ...runState, launchedAt: at });

      appendRunJournalEntry(clockedContext.workspaceDir, input.draftId, { kind: "launched", at: context.clock() });

      let venue: LocalVenue;
      try {
        venue = createVenue({ workspaceDir: clockedContext.workspaceDir, now: context.clock });
      } catch (cause) {
        refuse("venue-unavailable", "venue", cause instanceof Error ? cause.message : String(cause));
      }

      try {
        const backend = createRecordingProxy(venue.backend, {
          workspaceDir: clockedContext.workspaceDir,
          draftId: input.draftId,
          liveClock: context.clock,
        });
        const driveDeps: DriveDeps = {
          workspaceDir: clockedContext.workspaceDir,
          draftId: input.draftId,
          venue,
          backend,
          runSha256: loaded.runSha256,
          owner: loaded.owner,
          cellWindowMs: loaded.runRecord.policy.cellWindow,
          liveClock: context.clock,
        };

        const events = launchAndWatch(loaded.benchRecord, loaded.runRecord, backend, {
          runDigest: `sha256:${loaded.runSha256}`,
          taskBytesFor: taskBytesForFactory(clockedContext.workspaceDir),
          clock: { now: () => new Date(context.clock()) },
        });
        await driveCellEvents(driveDeps, events);
      } finally {
        await venue.shutdown();
      }

      return { draft };
    },
  });
}

export function runResume(
  context: OperationContext,
  input: RunResumeInput,
  deps: RunLaunchDeps = {},
): Promise<OperationResult<RunResumeResult>> {
  const at = context.clock();
  const clockedContext: OperationContext = { ...context, clock: () => at };
  const createVenue = deps.createVenue ?? createLocalVenue;

  return operateAsync({
    context: clockedContext,
    action: "run.resume",
    subject: input.draftId,
    inputs: input,
    run: async () => {
      const loaded = loadLockedOrRunningRun(clockedContext.workspaceDir, input.draftId, "running");

      const entries = readRunJournalEntries(clockedContext.workspaceDir, input.draftId);
      const fold = foldRunJournal(entries);
      const expected = expectedCellSet(loaded.benchRecord, loaded.runRecord);
      const outstanding = outstandingCells(expected, fold);

      const journaledSubmissions = new Map<string, string>();
      for (const entry of entries) {
        if (entry.kind === "submission-accepted") {
          journaledSubmissions.set(`${entry.cellKey}::${entry.dispatch}`, entry.submissionSha256);
        }
      }

      let venue: LocalVenue;
      try {
        venue = createVenue({ workspaceDir: clockedContext.workspaceDir, now: context.clock });
      } catch (cause) {
        refuse("venue-unavailable", "venue", cause instanceof Error ? cause.message : String(cause));
      }

      try {
        const backend = createRecordingProxy(venue.backend, {
          workspaceDir: clockedContext.workspaceDir,
          draftId: input.draftId,
          liveClock: context.clock,
        });
        const driveDeps: DriveDeps = {
          workspaceDir: clockedContext.workspaceDir,
          draftId: input.draftId,
          venue,
          backend,
          runSha256: loaded.runSha256,
          owner: loaded.owner,
          cellWindowMs: loaded.runRecord.policy.cellWindow,
          liveClock: context.clock,
        };

        if (outstanding.length > 0) {
          const events = resumeRun(loaded.benchRecord, loaded.runRecord, backend, {
            runDigest: `sha256:${loaded.runSha256}`,
            taskBytesFor: taskBytesForFactory(clockedContext.workspaceDir),
            clock: { now: () => new Date(context.clock()) },
            outstanding,
            acceptedSubmissions: {
              acceptedSubmissionBytes: (_runDigest, cellKey, dispatch) => {
                const sha256 = journaledSubmissions.get(`${cellKey}::${dispatch}`);
                return sha256 === undefined ? undefined : getSealedBytes(clockedContext.workspaceDir, sha256);
              },
            },
          });
          await driveCellEvents(driveDeps, events);
        }

        // Re-fold fresh: catches gaps left by THIS resume's own new deliveries as well as any
        // carried over from before it, without re-driving a solve dispatch for either.
        const freshFold = foldRunJournal(readRunJournalEntries(clockedContext.workspaceDir, input.draftId));
        const gaps = deliveredWithoutEvaluation(freshFold).filter(
          (cell): cell is typeof cell & { deliverySha256: string } => cell.deliverySha256 !== undefined,
        );
        if (gaps.length > 0) {
          await driveEvaluationCatchUp(
            driveDeps,
            gaps.map((cell) => ({
              cellKey: cell.cellKey,
              lastDispatch: cell.lastDispatch,
              deliverySha256: cell.deliverySha256,
              ...(cell.deliveryOutputs !== undefined ? { deliveryOutputs: cell.deliveryOutputs } : {}),
            })),
          );
        }

        return { outstandingCount: outstanding.length, evaluationCatchUpCount: gaps.length };
      } finally {
        await venue.shutdown();
      }
    },
  });
}
