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
 *
 * BP-22: both generators are composed with `../run/cancellation-aware-backend.ts`, which maps a
 * durable cancel marker to the existing backend cancellation port while preserving the platform
 * generator as the sole owner of dispatch/watch/drain orchestration. Its AbortSignal flips only
 * after the active attempt has terminalized, so cancellation cannot take the platform's dynamic
 * early-close escape from a watch loop and drop an in-flight attempt. `runResume` additionally
 * refuses `"conflict"` up front when a marker is ALREADY present at call time: an interrupted
 * cancel resumes by re-running `cancel`, never by running `resume`.
 */

import {
  expectedCellSet,
  parseBenchmark,
  parseRun,
  type BenchmarkRecord,
  type RunRecord,
} from "@jinn-network/benchmarking-records";
import { randomUUID } from "node:crypto";
import { launchAndWatch, resumeRun } from "@jinn-network/benchmarking-run";
import type { DraftDocument } from "../domain/draft.js";
import { transition } from "../domain/lifecycle.js";
import { refuse, toErrorEnvelope } from "../errors.js";
import { atomicWriteFileSync } from "../fs/atomic.js";
import { cancelRequested } from "../run/cancel-marker.js";
import { createCancellationAwareBackend } from "../run/cancellation-aware-backend.js";
import {
  createRecordingProxy,
  driveCellEvents,
  driveEvaluationCatchUp,
  type DriveDeps,
} from "../run/drive.js";
import {
  appendRunJournalEntry,
  evaluationGaps,
  foldRunJournal,
  outstandingCells,
  readRunJournalEntries,
} from "../run/journal.js";
import { requireRunState, writeRunState } from "../run/state.js";
import { draftPath } from "../workspace/layout.js";
import { getSealedBytes } from "../workspace/sealed-store.js";
import { createLocalVenue, type LocalVenue } from "../venue/venue.js";
import { createRuntimeVenue } from "../runtime/adapter.js";
import type { OperationContext } from "./context.js";
import { readDraftDocument } from "./drafts.js";
import { operateAsync } from "./operate-async.js";
import type { OperationResult } from "./result.js";

export interface RunLaunchDeps {
  readonly createVenue?: typeof createLocalVenue;
  /** Live diagnostic stream (BP-13) threaded straight through to `DriveDeps.onProgress` — see
   * `../run/drive.ts`'s own header for exactly what it emits and when. Optional; absent leaves
   * `runLaunch`/`runResume` byte-identical to before this deliverable. */
  readonly onProgress?: (line: string) => void;
  /** Test/diagnostic hook fired once when a solve attempt is first observed nonterminal. */
  readonly onSolveAttemptNonterminal?: (attempt: string) => void;
  /** TEST-ONLY: delay each real solve subprocess before its runner starts. The web client exposes
   * this only behind two explicit server-side test-control environment opt-ins. */
  readonly solveStartDelayMsForTesting?: number;
  /** TEST-ONLY deterministic generation source. Production uses a core-owned random UUID. */
  readonly driverGenerationForTesting?: () => string;
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

function assertVenueOwnership(venue: LocalVenue): void {
  try {
    venue.assertRunOwnership?.();
  } catch (cause) {
    refuse("venue-unavailable", "venue", cause instanceof Error ? cause.message : String(cause));
  }
}

async function preflightVenue(venue: LocalVenue): Promise<void> {
  try {
    await venue.preflightRun?.();
  } catch (cause) {
    refuse("venue-unavailable", "venue", cause instanceof Error ? cause.message : String(cause));
  }
}

async function runDriverGeneration<T>(
  context: OperationContext,
  draftId: string,
  operation: "launch" | "resume",
  generation: string,
  run: () => Promise<T>,
): Promise<T> {
  const startedAt = context.clock();
  appendRunJournalEntry(context.workspaceDir, draftId, {
    kind: "driver-started",
    at: startedAt,
    operation,
    generation,
  });
  try {
    const result = await run();
    appendRunJournalEntry(context.workspaceDir, draftId, {
      kind: "driver-succeeded",
      at: context.clock(),
      operation,
      generation,
    });
    return result;
  } catch (cause) {
    const failure = toErrorEnvelope(cause);
    appendRunJournalEntry(context.workspaceDir, draftId, {
      kind: "driver-failed",
      at: context.clock(),
      operation,
      generation,
      error: {
        code: failure.code,
        detail: failure.detail,
        ...(failure.issues !== undefined ? { issues: failure.issues.map((issue) => ({ ...issue })) } : {}),
      },
    });
    throw cause;
  }
}

export function runLaunch(
  context: OperationContext,
  input: RunLaunchInput,
  deps: RunLaunchDeps = {},
): Promise<OperationResult<RunLaunchResult>> {
  const at = context.clock();
  const clockedContext: OperationContext = { ...context, clock: () => at };
  return operateAsync({
    context: clockedContext,
    action: "launch",
    subject: input.draftId,
    inputs: input,
    run: async () => {
      const loaded = loadLockedOrRunningRun(clockedContext.workspaceDir, input.draftId, "locked");
      const createVenue: typeof createLocalVenue = deps.createVenue
        ?? ((options) => createRuntimeVenue(loaded.document.spec.evaluationRuntime, options, context.runtimeHost));

      const transitioned = transition("locked", "launch");
      if (!transitioned.ok) {
        refuse("illegal-transition", `drafts.${input.draftId}.state`, transitioned.error.detail);
      }
      const draft: DraftDocument = { ...loaded.document, state: transitioned.state, updatedAt: at };
      atomicWriteFileSync(draftPath(clockedContext.workspaceDir, input.draftId), JSON.stringify(draft, null, 2));

      const runState = requireRunState(clockedContext.workspaceDir, input.draftId);
      writeRunState(clockedContext.workspaceDir, input.draftId, { ...runState, launchedAt: at });

      appendRunJournalEntry(clockedContext.workspaceDir, input.draftId, { kind: "launched", at: context.clock() });

      // From the SEALED Run record, never the draft — the Run is the pre-registration (BP-21).
      // The product's compile always sets policy.evaluation, but the platform schema leaves
      // minVerdicts optional, so default defensively.
      const minVerdicts = loaded.runRecord.policy.evaluation?.minVerdicts ?? 1;
      const maxInfrastructureRetries = loaded.runRecord.policy.evaluation?.maxInfrastructureRetries ?? 0;

      let venue: LocalVenue;
      try {
        venue = createVenue({
          workspaceDir: clockedContext.workspaceDir,
          now: context.clock,
          evaluatorCount: minVerdicts,
          ...(deps.solveStartDelayMsForTesting !== undefined
            ? { solveStartDelayMsForTesting: deps.solveStartDelayMsForTesting }
            : {}),
        });
      } catch (cause) {
        refuse("venue-unavailable", "venue", cause instanceof Error ? cause.message : String(cause));
      }

      let shutdownAttempted = false;
      const shutdownVenue = async (): Promise<void> => {
        shutdownAttempted = true;
        await venue.shutdown();
      };
      try {
        assertVenueOwnership(venue);

        return await runDriverGeneration(
          context,
          input.draftId,
          "launch",
          deps.driverGenerationForTesting?.() ?? randomUUID(),
          async () => {
            let cancellation: ReturnType<typeof createCancellationAwareBackend> | undefined;
            try {
              await preflightVenue(venue);
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
                minVerdicts,
                maxInfrastructureRetries,
                liveClock: context.clock,
                onProgress: deps.onProgress,
              };

              cancellation = createCancellationAwareBackend(backend, {
                workspaceDir: clockedContext.workspaceDir,
                draftId: input.draftId,
                onAttemptNonterminal: deps.onSolveAttemptNonterminal,
              });
              const events = launchAndWatch(loaded.benchRecord, loaded.runRecord, cancellation.backend, {
                runDigest: `sha256:${loaded.runSha256}`,
                taskBytesFor: taskBytesForFactory(clockedContext.workspaceDir),
                ...(venue.solveCapabilityGrants === undefined
                  ? {}
                  : { capabilityGrants: venue.solveCapabilityGrants }),
                clock: { now: () => new Date(context.clock()) },
                signal: cancellation.signal,
                get earlyClose() {
                  return cancellation!.earlyClose;
                },
              });
              await driveCellEvents(driveDeps, events);
              return { draft };
            } finally {
              try {
                await cancellation?.close();
              } finally {
                // A generation is not successful until every venue resource has closed. Keeping
                // shutdown inside this callback makes a late rejection a durable driver-failed.
                await shutdownVenue();
              }
            }
          },
        );
      } finally {
        // `driver-started` itself can fail before its callback is entered; that path still owns a
        // venue and must release it, while every entered generation shuts down exactly once above.
        if (!shutdownAttempted) await shutdownVenue();
      }
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
  return operateAsync({
    context: clockedContext,
    action: "run.resume",
    subject: input.draftId,
    inputs: input,
    run: async () => {
      const loaded = loadLockedOrRunningRun(clockedContext.workspaceDir, input.draftId, "running");
      const createVenue: typeof createLocalVenue = deps.createVenue
        ?? ((options) => createRuntimeVenue(loaded.document.spec.evaluationRuntime, options, context.runtimeHost));

      // BP-22: a pending cancellation is finalized by re-running `cancel`, never by `resume` —
      // an interrupted cancel left the run mid-drain, and `cancel` is the only operation that
      // knows how to pick that back up (re-derive outstanding, re-probe the venue, finalize).
      if (cancelRequested(clockedContext.workspaceDir, input.draftId)) {
        refuse(
          "conflict",
          `runs.${input.draftId}`,
          `draft ${input.draftId} has a pending cancellation — run "cancel" to resume it, not "resume"`,
        );
      }

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

      // From the SEALED Run record, never the draft (BP-21) — same reasoning as runLaunch.
      const minVerdicts = loaded.runRecord.policy.evaluation?.minVerdicts ?? 1;
      const maxInfrastructureRetries = loaded.runRecord.policy.evaluation?.maxInfrastructureRetries ?? 0;

      let venue: LocalVenue;
      try {
        venue = createVenue({
          workspaceDir: clockedContext.workspaceDir,
          now: context.clock,
          evaluatorCount: minVerdicts,
          ...(deps.solveStartDelayMsForTesting !== undefined
            ? { solveStartDelayMsForTesting: deps.solveStartDelayMsForTesting }
            : {}),
        });
      } catch (cause) {
        refuse("venue-unavailable", "venue", cause instanceof Error ? cause.message : String(cause));
      }

      let shutdownAttempted = false;
      const shutdownVenue = async (): Promise<void> => {
        shutdownAttempted = true;
        await venue.shutdown();
      };
      try {
        assertVenueOwnership(venue);

        return await runDriverGeneration(
          context,
          input.draftId,
          "resume",
          deps.driverGenerationForTesting?.() ?? randomUUID(),
          async () => {
            let cancellation: ReturnType<typeof createCancellationAwareBackend> | undefined;
            try {
              await preflightVenue(venue);
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
                minVerdicts,
                maxInfrastructureRetries,
                liveClock: context.clock,
                onProgress: deps.onProgress,
              };

              if (outstanding.length > 0) {
                cancellation = createCancellationAwareBackend(backend, {
                  workspaceDir: clockedContext.workspaceDir,
                  draftId: input.draftId,
                  onAttemptNonterminal: deps.onSolveAttemptNonterminal,
                });
                const events = resumeRun(loaded.benchRecord, loaded.runRecord, cancellation.backend, {
                  runDigest: `sha256:${loaded.runSha256}`,
                  taskBytesFor: taskBytesForFactory(clockedContext.workspaceDir),
                  ...(venue.solveCapabilityGrants === undefined
                    ? {}
                    : { capabilityGrants: venue.solveCapabilityGrants }),
                  clock: { now: () => new Date(context.clock()) },
                  outstanding,
                  signal: cancellation.signal,
                  get earlyClose() {
                    return cancellation!.earlyClose;
                  },
                  acceptedSubmissions: {
                    acceptedSubmissionBytes: (_runDigest, cellKey, dispatch) => {
                      const sha256 = journaledSubmissions.get(`${cellKey}::${dispatch}`);
                      return sha256 === undefined ? undefined : getSealedBytes(clockedContext.workspaceDir, sha256);
                    },
                  },
                });
                await driveCellEvents(driveDeps, events);
              }

              // Re-fold fresh: catches gaps left by THIS resume's own new deliveries as well as
              // any carried over from before it, without re-driving a solve dispatch for either.
              const freshFold = foldRunJournal(readRunJournalEntries(clockedContext.workspaceDir, input.draftId));
              const gaps = (cancelRequested(clockedContext.workspaceDir, input.draftId)
                ? []
                : evaluationGaps(freshFold, minVerdicts, maxInfrastructureRetries)).filter(
                (gap): gap is typeof gap & { cell: typeof gap.cell & { deliverySha256: string } } =>
                  gap.cell.deliverySha256 !== undefined,
              );
              if (gaps.length > 0) {
                await driveEvaluationCatchUp(
                  driveDeps,
                  gaps.map((gap) => ({
                    cellKey: gap.cell.cellKey,
                    lastDispatch: gap.cell.lastDispatch,
                    deliverySha256: gap.cell.deliverySha256,
                    ...(gap.cell.deliveryOutputs !== undefined ? { deliveryOutputs: gap.cell.deliveryOutputs } : {}),
                    missingEvalIndexes: gap.missingEvalIndexes,
                    nextEvaluationAttempts: gap.nextEvaluationAttempts,
                  })),
                );
              }

              return { outstandingCount: outstanding.length, evaluationCatchUpCount: gaps.length };
            } finally {
              try {
                await cancellation?.close();
              } finally {
                await shutdownVenue();
              }
            }
          },
        );
      } finally {
        if (!shutdownAttempted) await shutdownVenue();
      }
    },
  });
}
