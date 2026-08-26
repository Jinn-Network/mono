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
import { sealJson } from "@jinn-network/record-discovery-protocol";
import { randomUUID } from "node:crypto";
import {
  launchAndWatch,
  MAX_CONCURRENT_CELLS,
  resumeRun,
  type LaunchOptions,
} from "@jinn-network/benchmarking-run";
import type { SubmissionUri } from "@jinn-network/task-execution-backend";
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
import { createProductLaunchCapture } from "../run/publication-capture.js";
import { createWorkspacePublicationSource, publicArchiveUrl, recordPath, withWorkspacePublicationSourceLock } from "../run/publication-source.js";
import { SUBMISSION_MEDIA_TYPE } from "@jinn-network/task-execution-protocol";
import {
  appendRunJournalEntry,
  evaluationGaps,
  foldRunJournal,
  outstandingCells,
  readRunJournalEntries,
} from "../run/journal.js";
import { requireRunState, writeRunState, type PublicationState } from "../run/state.js";
import { draftPath } from "../workspace/layout.js";
import { getSealedBytes, putSealedBytes } from "../workspace/sealed-store.js";
import { createLocalVenue, type LocalVenue } from "../venue/venue.js";
import { createRuntimeVenue } from "../runtime/adapter.js";
import { APEX_SWE_DEV_ADAPTER_ID } from "../runtime/apex-swe-dev/manifest.js";
import { harborRetryUnscorableFacts } from "../runtime/harbor/retry-bind.js";
import { deriveInspectEvaluationStrategy } from "../runtime/inspect/assurance.js";
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
  /** TEST-ONLY §7.4 host classifier. Production launch never supplies host facts. */
  readonly hostTerminalFacts?: LaunchOptions["hostTerminalFacts"];
}

export interface RunLaunchInput {
  readonly draftId: string;
  readonly maxConcurrentCells?: number;
}

export interface RunLaunchResult {
  readonly draft: DraftDocument;
}

function prospectiveRegistrationVerified(publication: PublicationState): boolean {
  return publication.registration.state === "complete"
    && publication.registration.receipt !== undefined
    && publication.source.publicBaseUrl !== undefined;
}

function requireProspectiveRegistrationVerified(publication: PublicationState, draftId: string): void {
  if (!prospectiveRegistrationVerified(publication)) {
    refuse(
      "conflict",
      `runs.${draftId}.publication.registration`,
      "prospective public registration is pending/unverified until it has a durable receipt and public locator; retry registration before dispatch",
    );
  }
}

export interface RunResumeInput {
  readonly draftId: string;
  readonly maxConcurrentCells?: number;
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

const APEX_SWE_DEV_OPERATOR_HOST_REFUSAL =
  "APEX-SWE-dev executes on the operator host, not through the Colophon venue: the protocol wraps"
  + " Mercor's own `apx` and `run_e2e.py` directly. `run launch` does not drive this protocol."
  + " Grade the locked selection with `yarn apex-swe-dev-one-task-qualify` (see"
  + " docs/runbooks/apex-swe-dev-official-one-task.md), then `apex-swe export`.";

/** APEX-SWE-dev seals arms against a harness id the local venue registers no launcher for, by
 * design (DR-2026-08-18-c: their harnesses run, unmodified, on the operator host). Refuse the
 * launch verb outright rather than dead-ending inside dispatch with an opaque venue error. */
function assertLaunchableRuntime(document: DraftDocument, draftId: string): void {
  if (document.spec.evaluationRuntime?.adapterId === APEX_SWE_DEV_ADAPTER_ID) {
    refuse(
      "venue-unavailable",
      `drafts.${draftId}.spec.evaluationRuntime.adapterId`,
      APEX_SWE_DEV_OPERATOR_HOST_REFUSAL,
    );
  }
}

function taskBytesForFactory(workspaceDir: string): (taskDigestHex: string) => Uint8Array {
  return (taskDigestHex) => getSealedBytes(workspaceDir, taskDigestHex);
}

function composeHostTerminalFacts(
  workspaceDir: string,
  override: RunLaunchDeps["hostTerminalFacts"],
): NonNullable<LaunchOptions["hostTerminalFacts"]> {
  return async (input) => {
    const fromOverride = await override?.(input);
    if (fromOverride !== undefined) return fromOverride;
    return harborRetryUnscorableFacts(workspaceDir, input.attempt);
  };
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
  maxConcurrentCells: number,
  run: () => Promise<T>,
): Promise<T> {
  const startedAt = context.clock();
  appendRunJournalEntry(context.workspaceDir, draftId, {
    kind: "driver-started",
    at: startedAt,
    operation,
    generation,
    maxConcurrentCells,
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

function requireMaxConcurrentCells(value: number | undefined): number {
  const resolved = value ?? 1;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > MAX_CONCURRENT_CELLS) {
    refuse(
      "validation",
      "maxConcurrentCells",
      `maxConcurrentCells must be an integer between 1 and ${MAX_CONCURRENT_CELLS}`,
    );
  }
  return resolved;
}

async function createRunLaunchCapture(
  workspaceDir: string,
  draftId: string,
  liveClock: () => string,
): Promise<ReturnType<typeof createProductLaunchCapture>> {
  const state = requireRunState(workspaceDir, draftId);
  const publication = state.publication;
  if (publication?.mode !== "prospective") {
    return createProductLaunchCapture({ workspaceDir, draftId, liveClock });
  }
  requireProspectiveRegistrationVerified(publication, draftId);
  const frozenCaptures = readRunJournalEntries(workspaceDir, draftId).filter(
    (entry) => entry.kind === "submission-captured" && entry.publicationSourceSequence !== undefined,
  );
  return createProductLaunchCapture({
    workspaceDir,
    draftId,
    liveClock,
    announceSubmission: async ({ bytes, digest, at }) => withWorkspacePublicationSourceLock(workspaceDir, async () => {
      const source = createWorkspacePublicationSource(workspaceDir, publication.source.name);
      if (source.source.agent !== publication.source.agentKeyRef || state.owner !== source.source.agent) {
        refuse("conflict", `runs.${draftId}.publication.source`, "Run owner and source agent must be the same stable workspace did:key");
      }
      await source.writer.recover();
      const prior = frozenCaptures.find((entry) => entry.kind === "submission-captured" && entry.submissionSha256 === digest.slice(7));
      const receipt = await source.writer.append({
        timestamp: prior?.at ?? at,
        announcement: {
          announcementId: `submission:${digest}`,
          action: "available",
          record: { kind: "https://spec.jinn.network/records/submission/v1", digest, mediaType: SUBMISSION_MEDIA_TYPE },
        },
        record: { bytes, contentType: SUBMISSION_MEDIA_TYPE },
      });
      const base = publication.source.publicBaseUrl!;
      const response = await fetch(publicArchiveUrl(base, recordPath(digest)));
      const observed = response.ok ? new Uint8Array(await response.arrayBuffer()) : undefined;
      if (observed === undefined || observed.length !== bytes.length || !observed.every((byte, index) => byte === bytes[index])) {
        throw new Error("prospective Submission was announced but is not exactly retrievable");
      }
      return { sequence: receipt.sequence, entrySha256: receipt.entryDigest.slice("sha256:".length) };
    }),
  });
}

/**
 * The prospective source append intentionally precedes the local capture journal write. If the
 * process stops between those two durable operations, reconstruct the missing local fact from the
 * source's signed archive before `resume` decides which exact Submission bytes to reuse.
 */
async function recoverProspectiveSubmissionCaptures(
  workspaceDir: string,
  draftId: string,
  run: RunRecord,
): Promise<void> {
  const runState = requireRunState(workspaceDir, draftId);
  const publication = runState.publication;
  if (publication?.mode !== "prospective" || publication.source.publicBaseUrl === undefined) return;

  await withWorkspacePublicationSourceLock(workspaceDir, async () => {
    const source = createWorkspacePublicationSource(workspaceDir, publication.source.name);
    if (source.source.agent !== publication.source.agentKeyRef || run.owner !== source.source.agent) {
      refuse("conflict", `runs.${draftId}.publication.source`, "Run owner and source agent must be the same stable workspace did:key");
    }
    await source.writer.recover();
    const state = await source.writer.readState();
    if (state === undefined) return;

    const expectedByCell = new Map(expectedCellSet(
      parseBenchmark(getSealedBytes(workspaceDir, run.benchmark.digest.sha256)),
      run,
    ).map((cell) => [cell.cellKey, cell] as const));
    const existing = new Map<string, string>();
    for (const entry of readRunJournalEntries(workspaceDir, draftId)) {
      if (entry.kind !== "submission-captured") continue;
      const key = `${entry.cellKey}::${entry.dispatch}`;
      const prior = existing.get(key);
      if (prior !== undefined && prior !== entry.submissionSha256) {
        refuse("record-integrity", `runs.${draftId}.${entry.cellKey}.${entry.dispatch}`, "capture journal contains conflicting Submission bytes");
      }
      existing.set(key, entry.submissionSha256);
    }

    for (const [announcementId, announcement] of Object.entries(state.announcements)) {
      const receipt = announcement.receipt;
      const record = receipt.record;
      if (
        announcement.action !== "available"
        || record === undefined
        || record.contentType !== SUBMISSION_MEDIA_TYPE
      ) continue;
      const digest = record.digest;
      if (announcementId !== `submission:${digest}`) {
        refuse("record-integrity", `runs.${draftId}.publication.source`, "prospective Submission announcement identity conflicts with its record digest");
      }
      const bytes = await source.recordStore.getExact(digest);
      if (bytes === undefined) {
        refuse("record-integrity", `runs.${draftId}.publication.source`, `prospective Submission ${digest} is missing from the source record store`);
      }
      let submission: { readonly nonce?: unknown };
      try {
        submission = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as { readonly nonce?: unknown };
      } catch {
        refuse("record-integrity", `runs.${draftId}.publication.source`, `prospective Submission ${digest} is not valid UTF-8 JSON`);
      }
      if (typeof submission.nonce !== "string") continue;
      const nonce = /^(.*):([1-9][0-9]*)$/u.exec(submission.nonce);
      if (nonce === null) continue;
      const cellKey = nonce[1]!;
      const dispatch = Number(nonce[2]);
      const cell = expectedByCell.get(cellKey);
      if (cell === undefined || !Number.isSafeInteger(dispatch)) continue;
      const coordinate = `${cellKey}::${dispatch}`;
      const digestHex = digest.slice("sha256:".length);
      const prior = existing.get(coordinate);
      if (prior !== undefined) {
        if (prior !== digestHex) {
          refuse("record-integrity", `runs.${draftId}.${cellKey}.${dispatch}`, "prospective source and capture journal name different Submission bytes");
        }
        continue;
      }

      const pageBytes = await source.archiveStore.getExact(receipt.page);
      if (pageBytes === undefined) {
        refuse("record-integrity", `runs.${draftId}.publication.source`, `prospective Submission ${digest} has no signed archive page`);
      }
      let page: { readonly entries?: readonly { readonly entry?: {
        readonly sequence?: unknown;
        readonly timestamp?: unknown;
        readonly announcements?: readonly { readonly announcementId?: unknown; readonly record?: { readonly digest?: unknown } }[];
      } }[] };
      try {
        page = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(pageBytes)) as typeof page;
      } catch {
        refuse("record-integrity", `runs.${draftId}.publication.source`, `prospective Submission ${digest} archive page is not valid UTF-8 JSON`);
      }
      const signed = page.entries?.find(({ entry }) =>
        entry?.sequence === receipt.sequence
        && sealJson(entry).digest === receipt.entryDigest
        && entry.announcements?.some((row) => row.announcementId === announcementId && row.record?.digest === digest));
      const timestamp = signed?.entry?.timestamp;
      if (typeof timestamp !== "string") {
        refuse("record-integrity", `runs.${draftId}.publication.source`, `prospective Submission ${digest} archive binding is invalid`);
      }

      const observed = await fetch(publicArchiveUrl(publication.source.publicBaseUrl!, recordPath(digest)));
      const observedBytes = observed.ok ? new Uint8Array(await observed.arrayBuffer()) : undefined;
      if (
        observedBytes === undefined
        || observedBytes.length !== bytes.length
        || !observedBytes.every((value, index) => value === bytes[index])
      ) {
        refuse("conflict", `runs.${draftId}.publication.source`, `prospective Submission ${digest} is not byte-exactly public`);
      }
      const stored = putSealedBytes(workspaceDir, bytes);
      if (stored !== digestHex) {
        refuse("record-integrity", `runs.${draftId}.publication.source`, `prospective Submission ${digest} failed local CAS reconstruction`);
      }
      appendRunJournalEntry(workspaceDir, draftId, {
        kind: "submission-captured",
        at: timestamp,
        cellKey,
        armId: cell.armId,
        replicate: cell.replicate,
        dispatch,
        submissionSha256: digestHex,
        publicationSourceSequence: receipt.sequence,
        publicationEntrySha256: receipt.entryDigest.slice("sha256:".length),
      });
      existing.set(coordinate, digestHex);
    }
  });
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
      const maxConcurrentCells = requireMaxConcurrentCells(input.maxConcurrentCells);
      const loaded = loadLockedOrRunningRun(clockedContext.workspaceDir, input.draftId, "locked");
      assertLaunchableRuntime(loaded.document, input.draftId);
      const publicationIntent = requireRunState(clockedContext.workspaceDir, input.draftId).publication;
      if (publicationIntent?.mode === "prospective") requireProspectiveRegistrationVerified(publicationIntent, input.draftId);
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
          maxConcurrentAttempts: maxConcurrentCells,
          agentProfileRequirements: loaded.runRecord.arms.map((arm) => arm.pinning as Readonly<Record<string, unknown>>),
          inspectEvaluationStrategy: deriveInspectEvaluationStrategy(loaded.runRecord.policy.evaluation),
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
          maxConcurrentCells,
          async () => {
            let cancellation: ReturnType<typeof createCancellationAwareBackend> | undefined;
            try {
              await preflightVenue(venue);
              const backend = createRecordingProxy(venue.backend, {
                workspaceDir: clockedContext.workspaceDir,
                draftId: input.draftId,
                liveClock: context.clock,
                recordSolveSubmissions: false,
              });
              const capture = await createRunLaunchCapture(clockedContext.workspaceDir, input.draftId, context.clock);
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
                capture,
                hostTerminalFacts: composeHostTerminalFacts(clockedContext.workspaceDir, deps.hostTerminalFacts),
                maxConcurrentCells,
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
      const maxConcurrentCells = requireMaxConcurrentCells(input.maxConcurrentCells);
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

      await recoverProspectiveSubmissionCaptures(
        clockedContext.workspaceDir,
        input.draftId,
        loaded.runRecord,
      );
      const entries = readRunJournalEntries(clockedContext.workspaceDir, input.draftId);
      const fold = foldRunJournal(entries);
      const expected = expectedCellSet(loaded.benchRecord, loaded.runRecord);
      const outstanding = outstandingCells(expected, fold);

      const journaledSubmissions = new Map<string, string>();
      for (const entry of entries) {
        // Pre-submit capture is the crash boundary. An interruption after backend acceptance but
        // before the accepted observation archive still resumes with these exact bytes rather
        // than sealing a new deadline under the same idempotency key.
        if (entry.kind === "submission-captured") {
          journaledSubmissions.set(`${entry.cellKey}::${entry.dispatch}`, entry.submissionSha256);
        } else if (entry.kind === "submission-accepted" && entry.leg !== "evaluation") {
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
          maxConcurrentAttempts: maxConcurrentCells,
          agentProfileRequirements: loaded.runRecord.arms.map((arm) => arm.pinning as Readonly<Record<string, unknown>>),
          inspectEvaluationStrategy: deriveInspectEvaluationStrategy(loaded.runRecord.policy.evaluation),
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
          maxConcurrentCells,
          async () => {
            let cancellation: ReturnType<typeof createCancellationAwareBackend> | undefined;
            try {
              await preflightVenue(venue);
              const backend = createRecordingProxy(venue.backend, {
                workspaceDir: clockedContext.workspaceDir,
                draftId: input.draftId,
                liveClock: context.clock,
                recordSolveSubmissions: false,
              });
              const capture = await createRunLaunchCapture(clockedContext.workspaceDir, input.draftId, context.clock);
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
                // A crash can occur after the local supervisor has durably written outcome.json
                // but before it harvests outputs and journals a terminal. Exact resubmission is
                // intentionally idempotent at the backend, but it is not itself the backend's
                // recovery operation. Reconcile each previously captured outstanding Submission
                // first; "absent" simply means the crash preceded backend acceptance and
                // resumeRun will submit those same bytes normally below.
                for (const cell of outstanding) {
                  const submissionSha256 = journaledSubmissions.get(
                    `${cell.cellKey}::${cell.dispatch}`,
                  );
                  if (submissionSha256 === undefined) continue;
                  const submissionBytes = getSealedBytes(
                    clockedContext.workspaceDir,
                    submissionSha256,
                  );
                  const submission = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
                    submissionBytes,
                  )) as { readonly submission?: unknown };
                  if (
                    typeof submission.submission !== "string"
                    || !submission.submission.startsWith("urn:uuid:")
                  ) {
                    refuse(
                      "record-integrity",
                      `runs.${input.draftId}.${cell.cellKey}.${cell.dispatch}`,
                      "captured outstanding Submission carries no valid Submission URI",
                    );
                  }
                  const reconciliation = await backend.recover(
                    submission.submission as SubmissionUri,
                  );
                  if (reconciliation.classification === "contradictory") {
                    refuse(
                      "record-integrity",
                      `runs.${input.draftId}.${cell.cellKey}.${cell.dispatch}`,
                      `backend recovery contradicted the captured Submission${
                        reconciliation.detail === undefined ? "" : `: ${reconciliation.detail}`
                      }`,
                    );
                  }
                }

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
                  capture,
                  hostTerminalFacts: composeHostTerminalFacts(clockedContext.workspaceDir, deps.hostTerminalFacts),
                  maxConcurrentCells,
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
