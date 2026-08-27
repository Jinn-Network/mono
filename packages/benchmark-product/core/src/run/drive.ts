/**
 * The shared run driver (BP-12, M1 composition dossier §1): consumes a stream of
 * `CellStatusEvent`s (from either `launchAndWatch` or `resumeRun`, `@jinn-network/benchmarking-run`),
 * durably journals every event, and — on each solve-side `delivered` terminal — dispatches this
 * product's own evaluation leg (design §13: "the application dispatches evaluation cells
 * itself"). `run-launch.ts`'s `runLaunch` and `runResume` both drive through this module so the
 * per-event handling (journal write, delivery harvest, evaluation dispatch) is defined exactly
 * once and cannot drift between the initial launch and a crash-safe resume.
 *
 * Two composable pieces:
 * - `createRecordingProxy` — a thin pass-through wrapper over the venue's real backend that
 *   calls the real backend and durably records only a genuinely accepted Submission (solve or
 *   evaluation). For solve legs it also stores the concrete backend's exact run-pinning proof,
 *   when present. It is bookkeeping only, never a backend substitute: every method forwards to
 *   the real backend.
 * - `driveCellEvents` — folds a `CellStatusEvent` stream into the run journal and, on delivery,
 *   runs the evaluation leg synchronously in-line (prepare → seal Submission → submit through
 *   the same proxy → drain → observe → harvest the verdict or record a could-not-grade fact).
 *
 * BP-13: `DriveDeps.onProgress`, when supplied, receives one short `<cellKey> <kind>` line right
 * after each cell-event journal write, plus `<cellKey> judged` / `<cellKey> could-not-grade` right
 * after each evaluation-leg terminal is journaled (`journalCouldNotGrade`, the success tail of
 * `dispatchEvaluation`) — with an ` e<i>/<n>` leg suffix when `minVerdicts > 1` (BP-21; the
 * minVerdicts=1 output stays byte-identical). It is a live stream for a long-running CLI verb
 * (`launch`/`resume`) to
 * surface, never a substitute for the journal itself — purely additive, so a caller that omits it
 * sees byte-identical journal and return-value behavior. It is a diagnostic sink only: it can
 * NEVER fail the run. Every call site goes through `emitProgress`, which swallows anything the
 * sink throws (e.g. EPIPE from `process.stderr.write` when the reader end of a pipe like
 * `launch | head` has closed) — a broken diagnostic stream is not a reason to abort a run whose
 * journal writes are already durable.
 */

import { parseCellKey } from "@jinn-network/benchmarking-records";
import type { CellStatusEvent } from "@jinn-network/benchmarking-run";
import { RECORD_KINDS } from "@jinn-network/record-discovery-protocol";
import {
  TaskExecutionError,
  type AttemptUri,
  type BackendCapabilities,
  type CancelAck,
  type DeliveryRef,
  type ObservationCursor,
  type ObservationSnapshot,
  type ReconciliationReport,
  type SubmissionAck,
  type SubmissionUri,
  type TwoPartyEngagement,
} from "@jinn-network/task-execution-backend";
import {
  DeliveryRecordSchema,
  sealSubmission,
  type DeliveryRecord,
  type ProtocolObservation,
  type ResourceDescriptor,
  type TaskExecutionErrorCategory,
} from "@jinn-network/task-execution-protocol";
import { isEvaluationOperationalError } from "@jinn-network/task-execution-evaluation-harness";
import { refuse } from "../errors.js";
import {
  EVALUATION_HARNESS_PIN,
  EVALUATOR_REQUIREMENT_KEY,
  type LocalVenue,
  type PreparedEvaluationCell,
} from "../venue/venue.js";
import { getSealedBytes, putSealedBytes } from "../workspace/sealed-store.js";
import { appendRunJournalEntry } from "./journal.js";
import { recordWorkspaceAuthorship } from "./publication-authority.js";
import {
  canonicalRunPinningEvidenceBytes,
  type VerifiedRunPinningCheck,
} from "./pinning-evidence.js";
import { deterministicUuidUri } from "./state.js";

/** What `launchAndWatch` / `resumeRun` need (`TaskExecutionBackend`) plus `drain` (the local
 * backend's own durability primitive — not on the frozen protocol interface). */
export interface ProxiedBackend {
  capabilities(): Promise<BackendCapabilities>;
  submit(taskBytes: Uint8Array, submissionBytes: Uint8Array, engagement?: TwoPartyEngagement): Promise<SubmissionAck>;
  observe(ref: SubmissionUri | AttemptUri): Promise<ObservationSnapshot>;
  watch?(ref: SubmissionUri | AttemptUri, cursor?: ObservationCursor): AsyncIterable<ProtocolObservation>;
  cancel?(attempt: AttemptUri, reason: string): Promise<CancelAck>;
  recover(ref: SubmissionUri | AttemptUri): Promise<ReconciliationReport>;
  deliveries(attempt: AttemptUri): Promise<DeliveryRef[]>;
  fetchDelivery(ref: DeliveryRef): Promise<Uint8Array>;
  fetchArtifact?(descriptor: ResourceDescriptor): Promise<Uint8Array>;
  /** Concrete local-backend evidence seam; absent means no real run-pinning proof exists. */
  pinningEvidenceForSubmission?(ref: SubmissionUri): VerifiedRunPinningCheck | undefined;
  drain(): Promise<void>;
}

export interface RecordingProxyDeps {
  readonly workspaceDir: string;
  readonly draftId: string;
  /** The live, unfrozen clock (see run-quote.ts's own note on why). */
  readonly liveClock: () => string;
  /** Solve dispatches captured by LaunchCapturePort must not be post-ack duplicated here. */
  readonly recordSolveSubmissions?: boolean;
}

/**
 * Parses `<...>:<cellKey>:<dispatch>` — the LAST two `:`-delimited segments — out of a
 * Submission's `nonce`. A solve dispatch's nonce IS exactly `<cellKey>:<dispatch>`
 * (`benchmarking-run`'s `launch.ts`); this product's own evaluation Submissions use
 * `eval:<runSha256>:e<evalIndex>:<cellKey>:<dispatch>` (`./drive.ts`'s own `dispatchEvaluation`,
 * below — the leg marker sits in the MIDDLE precisely so cellKey and dispatch stay the last two
 * segments) — a cellKey never itself contains `:`, so the last-two-segments rule reads correctly
 * under both shapes without the proxy needing to know which kind of Submission it is looking at.
 */
function cellKeyAndDispatchFromNonce(nonce: string): { cellKey: string; dispatch: number } | undefined {
  const parts = nonce.split(":");
  if (parts.length < 2) return undefined;
  const cellKey = parts.at(-2);
  const dispatchText = parts.at(-1);
  if (cellKey === undefined || dispatchText === undefined) return undefined;
  const dispatch = Number(dispatchText);
  if (!Number.isInteger(dispatch) || dispatch < 1) return undefined;
  return { cellKey, dispatch };
}

function evaluationCoordinateFromNonce(nonce: string): {
  evalIndex: number;
  evaluationAttempt: number;
} | undefined {
  const match = /^eval:[a-f0-9]{64}:e([1-9][0-9]*)(?::r([1-9][0-9]*))?:/u.exec(nonce);
  if (match === null) return undefined;
  return {
    evalIndex: Number(match[1]),
    evaluationAttempt: match[2] === undefined ? 1 : Number(match[2]),
  };
}

/**
 * Wraps a backend so every accepted Submission is durably recorded (module header). Typed over
 * the minimal `ProxiedBackend` shape rather than `LocalVenue["backend"]`'s concrete class so a
 * test double satisfying the same methods can be wrapped too — the real
 * `LocalTaskExecutionBackend` instance `venue.backend` (production callers pass) structurally
 * satisfies `ProxiedBackend` and needs no adaptation.
 */
export function createRecordingProxy(
  backend: ProxiedBackend,
  deps: RecordingProxyDeps,
): ProxiedBackend {
  return {
    capabilities: () => backend.capabilities(),
    async submit(taskBytes, submissionBytes, engagement) {
      let parsed: { nonce?: unknown } | undefined;
      try {
        parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(submissionBytes)) as { nonce?: unknown };
      } catch {
        parsed = undefined;
      }
      const nonce = typeof parsed?.nonce === "string" ? parsed.nonce : undefined;
      const coord = nonce === undefined ? undefined : cellKeyAndDispatchFromNonce(nonce);
      const ack = await backend.submit(taskBytes, submissionBytes, engagement);
      if (ack.accepted && coord !== undefined && nonce !== undefined) {
        const submissionSha256 = putSealedBytes(deps.workspaceDir, submissionBytes);
        const leg = nonce.startsWith("eval:") ? "evaluation" : "solve";
        const evaluationCoordinate = leg === "evaluation"
          ? evaluationCoordinateFromNonce(nonce)
          : undefined;
        const pinningEvidence = leg === "solve"
          ? backend.pinningEvidenceForSubmission?.(ack.submission)
          : undefined;
        const pinningEvidenceSha256 = pinningEvidence === undefined
          ? undefined
          : putSealedBytes(
            deps.workspaceDir,
            canonicalRunPinningEvidenceBytes(pinningEvidence, ack.digest),
          );
        if (leg === "solve" && deps.recordSolveSubmissions === false) {
          if (pinningEvidenceSha256 !== undefined) {
            appendRunJournalEntry(deps.workspaceDir, deps.draftId, {
              kind: "submission-pinning-evidence",
              at: deps.liveClock(),
              cellKey: coord.cellKey,
              dispatch: coord.dispatch,
              submissionSha256,
              pinningEvidenceSha256,
            });
          }
        } else {
          appendRunJournalEntry(deps.workspaceDir, deps.draftId, {
            kind: "submission-accepted",
            at: deps.liveClock(),
            cellKey: coord.cellKey,
            dispatch: coord.dispatch,
            submissionSha256,
            // The `eval:` prefix is this driver's own evaluation-nonce marker (see
            // `cellKeyAndDispatchFromNonce`'s doc comment); everything else is a solve dispatch.
            leg,
            ...(evaluationCoordinate === undefined ? {} : evaluationCoordinate),
            ...(pinningEvidenceSha256 === undefined ? {} : { pinningEvidenceSha256 }),
          });
        }
      }
      return ack;
    },
    observe: (ref) => backend.observe(ref),
    watch: backend.watch === undefined ? undefined : (ref, cursor) => backend.watch!(ref, cursor),
    cancel: backend.cancel === undefined ? undefined : (attempt, reason) => backend.cancel!(attempt, reason),
    recover: (ref) => backend.recover(ref),
    deliveries: (attempt) => backend.deliveries(attempt),
    fetchDelivery: (ref) => backend.fetchDelivery(ref),
    fetchArtifact: backend.fetchArtifact === undefined ? undefined : (descriptor) => backend.fetchArtifact!(descriptor),
    pinningEvidenceForSubmission: backend.pinningEvidenceForSubmission === undefined
      ? undefined
      : (ref) => backend.pinningEvidenceForSubmission!(ref),
    drain: () => backend.drain(),
  };
}

export interface DriveDeps {
  readonly workspaceDir: string;
  readonly draftId: string;
  readonly venue: LocalVenue;
  readonly backend: ProxiedBackend;
  /** Bare hex sha256 of the sealed Run record. */
  readonly runSha256: string;
  readonly owner: string;
  readonly cellWindowMs: number;
  /** `policy.evaluation.minVerdicts` from the SEALED Run record (integer >= 1) — how many
   * evaluation legs each delivered solve cell gets, one per distinct venue evaluator identity
   * (BP-21). The venue must have been created with `evaluatorCount >= minVerdicts`. */
  readonly minVerdicts: number;
  /** Sealed provider-outage retry allowance. Legacy runs omit it and callers pass zero. */
  readonly maxInfrastructureRetries?: 0 | 1;
  /** The live, unfrozen clock — journal timestamps reflect when each event actually happened. */
  readonly liveClock: () => string;
  /**
   * Resume's byte-exact replay seam for the EVALUATION leg, symmetric with the solve leg's
   * `acceptedSubmissions.acceptedSubmissionBytes` (`../operations/run-launch.js`'s `resumeRun`
   * call). Returns the exact Submission bytes the backend already accepted for this leg, or
   * `undefined` when this leg was never submitted.
   *
   * Without it, a process killed between backend acceptance and the leg's verdict resumes by
   * sealing FRESH bytes: `dispatchEvaluation`'s deadline is `liveClock() + cellWindowMs`, so the
   * replay carries a later deadline under the SAME idempotency key. The backend rehydrates its
   * accepted-submission scope from the durable state root and correctly refuses ("already has
   * different exact bytes in this requester/backend scope"), which terminals the leg
   * could-not-grade — permanently, since that completes the evalIndex.
   */
  readonly acceptedEvaluationSubmissionBytes?: (
    cellKey: string,
    dispatch: number,
    evalIndex: number,
    evaluationAttempt: number,
  ) => Uint8Array | undefined;
  /** Live diagnostic stream (BP-13, CLI `launch`/`resume`) — one short line per journaled
   * cell-event or evaluation terminal, emitted right after the journal write it describes.
   * Optional and purely additive: absent, nothing streams, and every journal write and return
   * value here is byte-identical either way. */
  readonly onProgress?: (line: string) => void;
}

/** Calls `deps.onProgress` and swallows anything it throws — see `DriveDeps.onProgress`'s own
 * doc comment: the diagnostic stream can never fail the run. */
function emitProgress(deps: DriveDeps, line: string): void {
  try {
    deps.onProgress?.(line);
  } catch {
    // Diagnostic sink only — deliberately swallowed.
  }
}

type CapturedDelivery = Pick<DeliveryRecord, "outputs" | "evidenceRecords"> & { readonly createdAt?: string };

/** A managed LocalVenue which proves ownership returns product-captured records without foreign
 * source coordinates. Bind only its locally-created Delivery and execution record families at
 * that first durable boundary; result-evaluation is bound after this product fetches its bytes. */
function recordManagedDeliveryAuthorship(
  deps: DriveDeps,
  deliverySha256: string,
  deliveryBytes: Uint8Array,
): CapturedDelivery {
  const decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(deliveryBytes)) as CapturedDelivery;
  if (deps.venue.assertRunOwnership === undefined) return decoded;
  deps.venue.assertRunOwnership();
  const delivery = DeliveryRecordSchema.parse(decoded);
  const localEvidence = (delivery.evidenceRecords ?? []).filter((candidate) => candidate.family !== "result-evaluation");
  for (const reference of localEvidence) getSealedBytes(deps.workspaceDir, reference.digest.slice("sha256:".length));
  recordWorkspaceAuthorship({
    workspaceDir: deps.workspaceDir,
    recordSha256: deliverySha256,
    recordKind: RECORD_KINDS.delivery,
    authoredAt: delivery.createdAt,
  });
  for (const reference of localEvidence) {
    const digestHex = reference.digest.slice("sha256:".length);
    const recordKind = reference.family === "execution-evidence"
      ? RECORD_KINDS.executionEvidence
      : RECORD_KINDS.executionVerification;
    recordWorkspaceAuthorship({
      workspaceDir: deps.workspaceDir,
      recordSha256: digestHex,
      recordKind,
      authoredAt: delivery.createdAt,
    });
  }
  return delivery;
}

/** ` e<i>/<n>` when minVerdicts > 1 and the line is leg-attributed; empty otherwise — keeps the
 * minVerdicts=1 progress output byte-identical to the pre-BP-21 single-leg stream. */
function legSuffix(deps: DriveDeps, evalIndex: number | undefined): string {
  return deps.minVerdicts > 1 && evalIndex !== undefined ? ` e${evalIndex}/${deps.minVerdicts}` : "";
}

function journalCouldNotGrade(
  deps: DriveDeps,
  cellKey: string,
  detail: string,
  extra: {
    evalTaskSha256?: string;
    evalDeliverySha256?: string;
    evalAttempt?: string;
    evaluator?: string;
    evalIndex?: number;
    evaluationAttempt?: number;
    failureCategory?: TaskExecutionErrorCategory;
  } = {},
): void {
  appendRunJournalEntry(deps.workspaceDir, deps.draftId, {
    kind: "evaluation",
    at: deps.liveClock(),
    cellKey,
    evaluationTerminal: "could-not-grade",
    detail,
    ...(extra.evalTaskSha256 !== undefined ? { evalTaskSha256: extra.evalTaskSha256 } : {}),
    ...(extra.evalDeliverySha256 !== undefined ? { evalDeliverySha256: extra.evalDeliverySha256 } : {}),
    ...(extra.evalAttempt !== undefined ? { evalAttempt: extra.evalAttempt } : {}),
    ...(extra.evaluator !== undefined ? { evaluator: extra.evaluator } : {}),
    ...(extra.evalIndex !== undefined ? { evalIndex: extra.evalIndex } : {}),
    ...(extra.evaluationAttempt !== undefined && extra.evaluationAttempt > 1
      ? { evaluationAttempt: extra.evaluationAttempt }
      : {}),
    ...(extra.failureCategory !== undefined ? { failureCategory: extra.failureCategory } : {}),
  });
  emitProgress(deps, `${cellKey} could-not-grade${legSuffix(deps, extra.evalIndex)}`);
}

const RETRYABLE_EVALUATION_CATEGORY_VALUES = [
  "backend-unavailable",
  "dependency-unavailable",
  "transport-failure",
] as const;
type RetryableEvaluationCategory = (typeof RETRYABLE_EVALUATION_CATEGORY_VALUES)[number];
const RETRYABLE_EVALUATION_CATEGORIES = new Set<TaskExecutionErrorCategory>(RETRYABLE_EVALUATION_CATEGORY_VALUES);

function isRetryableEvaluationCategory(category: TaskExecutionErrorCategory): category is RetryableEvaluationCategory {
  return RETRYABLE_EVALUATION_CATEGORIES.has(category);
}

interface RetryableEvaluationFailure {
  readonly category: RetryableEvaluationCategory;
  readonly detail: string;
}

function retryableFailureFromCause(cause: unknown): RetryableEvaluationFailure | undefined {
  if (cause instanceof TaskExecutionError && isRetryableEvaluationCategory(cause.category)) {
    return { category: cause.category, detail: cause.detail ?? cause.message };
  }
  if (
    isEvaluationOperationalError(cause)
    && cause.canonicalCode === "UNAVAILABLE"
    && cause.reason === "provider-unavailable"
    && cause.recoveryAdvice === "new-attempt-required"
  ) {
    return { category: "dependency-unavailable", detail: cause.safeDetail };
  }
  return undefined;
}

function retryableFailureFromSnapshot(snapshot: ObservationSnapshot): RetryableEvaluationFailure | undefined {
  const terminal = [...snapshot.observations].reverse().find((observation) =>
    observation.type === "network.jinn.task-execution.attempt-terminal.v1");
  if (
    terminal?.type !== "network.jinn.task-execution.attempt-terminal.v1"
    || terminal.data.blame !== "infrastructure"
    || !isRetryableEvaluationCategory(terminal.data.category as TaskExecutionErrorCategory)
  ) return undefined;
  return {
    category: terminal.data.category as RetryableEvaluationCategory,
    detail: terminal.data.detail ?? terminal.data.category!,
  };
}

function journalEvaluationFailure(
  deps: DriveDeps,
  input: {
    readonly cellKey: string;
    readonly dispatch: number;
    readonly evalIndex: number;
    readonly evaluationAttempt: number;
    readonly evaluator: string;
    readonly detail: string;
    readonly retryable?: RetryableEvaluationFailure;
    readonly evalTaskSha256?: string;
    readonly evalAttempt?: string;
  },
): void {
  if (
    input.retryable !== undefined
    && input.evaluationAttempt <= (deps.maxInfrastructureRetries ?? 0)
  ) {
    appendRunJournalEntry(deps.workspaceDir, deps.draftId, {
      kind: "evaluation-retryable-failure",
      at: deps.liveClock(),
      cellKey: input.cellKey,
      dispatch: input.dispatch,
      evalIndex: input.evalIndex,
      evaluationAttempt: input.evaluationAttempt,
      evaluator: input.evaluator,
      ...(input.evalTaskSha256 === undefined ? {} : { evalTaskSha256: input.evalTaskSha256 }),
      ...(input.evalAttempt === undefined ? {} : { evalAttempt: input.evalAttempt }),
      category: input.retryable.category,
      recoveryAdvice: "new-attempt-required",
      detail: input.retryable.detail,
    });
    emitProgress(deps, `${input.cellKey} evaluation-retry-pending${legSuffix(deps, input.evalIndex)}`);
    return;
  }
  journalCouldNotGrade(deps, input.cellKey, input.detail, {
    ...(input.evalTaskSha256 === undefined ? {} : { evalTaskSha256: input.evalTaskSha256 }),
    ...(input.evalAttempt === undefined ? {} : { evalAttempt: input.evalAttempt }),
    evaluator: input.evaluator,
    evalIndex: input.evalIndex,
    evaluationAttempt: input.evaluationAttempt,
    ...(input.retryable === undefined ? {} : { failureCategory: input.retryable.category }),
  });
}

/**
 * Journals one could-not-grade terminal PER LEG for a failure that precedes any leg-specific
 * work (no attempt reference, unreadable delivery, missing EvaluationSpec, prepare failure).
 * Fanning the shared failure out per leg keeps the fold's per-leg accounting
 * (`completedEvalIndexes`) convergent: every leg in `evalIndexes` gets its terminal, so a later
 * `evaluationGaps` sweep does not re-attempt legs that can never be graded. No `evaluator` is
 * recorded — the failure happened before any evaluator was selected for these legs.
 */
function journalCouldNotGradeLegs(
  deps: DriveDeps,
  cellKey: string,
  detail: string,
  evalIndexes: readonly number[],
  extra: { evalTaskSha256?: string } = {},
): void {
  for (const evalIndex of evalIndexes) {
    journalCouldNotGrade(deps, cellKey, detail, { ...extra, evalIndex });
  }
}

/** The 1-based leg indexes a fresh delivery runs: `1..minVerdicts`. */
function allEvalIndexes(deps: DriveDeps): number[] {
  return Array.from({ length: deps.minVerdicts }, (_, i) => i + 1);
}

/**
 * Refuses loudly on wiring bugs before any leg work starts: a non-integer/sub-1 `minVerdicts`,
 * or a venue minted with fewer evaluator identities than `minVerdicts` demands. These are
 * caller bugs (`run-launch.ts` creates the venue with `evaluatorCount: minVerdicts`), never
 * per-cell facts — degrading them into per-cell could-not-grade entries would paper a broken
 * assembly over the whole run's evaluation record.
 */
function requireEvaluatorCoverage(deps: DriveDeps): void {
  if (!Number.isSafeInteger(deps.minVerdicts) || deps.minVerdicts < 1) {
    refuse("validation", "minVerdicts", "minVerdicts must be an integer >= 1");
  }
  if (deps.venue.evaluators.length < deps.minVerdicts) {
    refuse(
      "execution",
      "venue.evaluators",
      `venue has ${deps.venue.evaluators.length} evaluator identities but policy.evaluation.minVerdicts is `
        + `${deps.minVerdicts} — the venue must be created with evaluatorCount >= minVerdicts`,
    );
  }
}

/** Seals + submits + watches ONE evaluation leg (`evalIndex`, 1-based) for a prepared evaluation
 * cell (module header): evaluator `deps.venue.evaluators[evalIndex - 1]`, leg-distinct
 * idempotency key/nonce `eval:<runSha256>:e<evalIndex>:<cellKey>:<dispatch>`. */
async function dispatchEvaluation(
  deps: DriveDeps,
  cellKey: string,
  dispatch: number,
  prepared: { readonly taskBytes: Uint8Array; readonly taskSha256: string },
  evalIndex: number,
  evaluationAttempt: number,
): Promise<void> {
  // `requireEvaluatorCoverage` already refused a venue too small for minVerdicts at drive entry.
  const evaluator = deps.venue.evaluators[evalIndex - 1]!;
  const legExtra = {
    evalTaskSha256: prepared.taskSha256,
    evaluator: evaluator.id,
    evalIndex,
    evaluationAttempt,
  };
  const idempotencyKey = evaluationAttempt === 1
    ? `eval:${deps.runSha256}:e${evalIndex}:${cellKey}:${dispatch}`
    : `eval:${deps.runSha256}:e${evalIndex}:r${evaluationAttempt}:${cellKey}:${dispatch}`;
  const submissionUri = deterministicUuidUri(idempotencyKey);
  // Resume replays the bytes the backend already accepted for this leg. Sealing fresh ones would
  // stamp a new `deadline` under this same idempotency key, which the backend refuses — see
  // `DriveDeps.acceptedEvaluationSubmissionBytes`.
  const replayed = deps.acceptedEvaluationSubmissionBytes?.(
    cellKey,
    dispatch,
    evalIndex,
    evaluationAttempt,
  );
  const evalSubmissionBytes = replayed ?? sealSubmission({
    protocol: "https://spec.jinn.network/profiles/task-execution/v1",
    submission: submissionUri,
    task: { digest: { sha256: prepared.taskSha256 } },
    requester: deps.owner,
    nonce: idempotencyKey,
    idempotencyKey,
    deadline: new Date(Date.parse(deps.liveClock()) + deps.cellWindowMs).toISOString(),
    requirements: { harness: EVALUATION_HARNESS_PIN, [EVALUATOR_REQUIREMENT_KEY]: evaluator.id },
  });

  const ack = await deps.backend.submit(prepared.taskBytes, evalSubmissionBytes);
  if (!ack.accepted) {
    const retryable = isRetryableEvaluationCategory(ack.error.category)
      ? { category: ack.error.category, detail: ack.error.detail ?? ack.error.category }
      : undefined;
    journalEvaluationFailure(deps, {
      cellKey,
      dispatch,
      ...legExtra,
      detail: ack.error.detail ?? ack.error.category,
      ...(retryable === undefined ? {} : { retryable }),
    });
    return;
  }
  await deps.backend.drain();
  const snapshot = await deps.backend.observe(ack.submission);
  const evalAttempt = snapshot.descriptor.attempt;
  if (snapshot.descriptor.derived.state !== "delivered") {
    const retryable = retryableFailureFromSnapshot(snapshot);
    journalEvaluationFailure(deps, {
      cellKey,
      dispatch,
      ...legExtra,
      detail: retryable?.detail ?? `evaluation attempt terminal state: ${snapshot.descriptor.derived.state}`,
      ...(evalAttempt === undefined ? {} : { evalAttempt }),
      ...(retryable === undefined ? {} : { retryable }),
    });
    return;
  }

  const refs = await deps.backend.deliveries(evalAttempt as AttemptUri);
  const deliveryRef = refs.at(-1);
  if (deliveryRef === undefined) {
    journalCouldNotGrade(deps, cellKey, "evaluation attempt delivered but no Delivery was recorded", {
      ...legExtra,
      evalAttempt,
    });
    return;
  }
  const deliveryBytes = await deps.backend.fetchDelivery(deliveryRef);
  const evalDeliverySha256 = putSealedBytes(deps.workspaceDir, deliveryBytes);
  const delivery = recordManagedDeliveryAuthorship(deps, evalDeliverySha256, deliveryBytes);
  const verdictOutput = delivery.outputs.find((output) => output.name === "verdict");
  if (verdictOutput?.digest?.sha256 === undefined) {
    journalCouldNotGrade(deps, cellKey, "evaluation delivery carries no verdict output", {
      ...legExtra,
      evalDeliverySha256,
      evalAttempt,
    });
    return;
  }
  if (deps.backend.fetchArtifact === undefined) {
    journalCouldNotGrade(deps, cellKey, "backend does not support fetchArtifact", {
      ...legExtra,
      evalDeliverySha256,
      evalAttempt,
    });
    return;
  }
  const envelopeBytes = await deps.backend.fetchArtifact({ digest: { sha256: verdictOutput.digest.sha256 } });
  const verdictSha256 = putSealedBytes(deps.workspaceDir, envelopeBytes);
  if (deps.venue.assertRunOwnership !== undefined) {
    deps.venue.assertRunOwnership();
    recordWorkspaceAuthorship({
      workspaceDir: deps.workspaceDir,
      recordSha256: verdictSha256,
      recordKind: RECORD_KINDS.resultEvaluation,
      authoredAt: delivery.createdAt!,
    });
  }

  appendRunJournalEntry(deps.workspaceDir, deps.draftId, {
    kind: "evaluation",
    at: deps.liveClock(),
    cellKey,
    evalTaskSha256: prepared.taskSha256,
    evalDeliverySha256,
    evalAttempt,
    verdictSha256,
    evaluator: evaluator.id,
    evalIndex,
    ...(evaluationAttempt === 1 ? {} : { evaluationAttempt }),
  });
  emitProgress(deps, `${cellKey} judged${legSuffix(deps, evalIndex)}`);
}

/**
 * The tail shared by a fresh delivery and a resumed (already-journaled) one: resolve the
 * subject Task's bound EvaluationSpec, prepare the evaluation cell ONCE (every leg grades the
 * same derived evaluation Task), then dispatch each leg in `evalIndexes` in order. A per-leg
 * failure never aborts the remaining legs — it journals could-not-grade for that leg and
 * continues; a pre-leg failure (spec resolution / prepare) fans out per leg
 * (`journalCouldNotGradeLegs`) so every requested leg still reaches a journaled terminal.
 */
async function prepareAndDispatchEvaluation(
  deps: DriveDeps,
  cellKey: string,
  dispatch: number,
  subjectDeliveryBytes: Uint8Array,
  resultArtifacts: readonly { readonly name: string; readonly bytes: Uint8Array }[],
  evalIndexes: readonly number[],
  evaluationAttempts: Readonly<Record<number, number>>,
): Promise<void> {
  if (deps.venue.evaluationMode === "embedded") {
    if (evalIndexes.some((index) => index !== 1) || deps.minVerdicts !== 1) {
      refuse(
        "execution",
        "minVerdicts",
        "an embedded same-execution scorer can account for exactly one evaluator leg",
      );
    }
    const interpreted = deps.venue.interpretEmbeddedEvaluation?.(resultArtifacts);
    if (interpreted === undefined) {
      journalCouldNotGrade(deps, cellKey, "embedded runtime has no evaluation interpreter", { evalIndex: 1 });
      return;
    }
    if (interpreted.kind === "could-not-grade") {
      journalCouldNotGrade(deps, cellKey, interpreted.detail, {
        evaluator: deps.venue.evaluators[0]?.id,
        evalIndex: 1,
      });
      return;
    }
    const verdictSha256 = putSealedBytes(deps.workspaceDir, interpreted.verdictBytes);
    appendRunJournalEntry(deps.workspaceDir, deps.draftId, {
      kind: "evaluation",
      at: deps.liveClock(),
      cellKey,
      verdictSha256,
      evaluator: interpreted.evaluatorId,
      evalIndex: 1,
    });
    emitProgress(deps, `${cellKey} judged`);
    return;
  }

  const taskDigestHex = parseCellKey(cellKey).taskDigest;
  const subjectTaskBytes = getSealedBytes(deps.workspaceDir, taskDigestHex);
  const subjectTaskDoc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(subjectTaskBytes)) as {
    readonly evaluation?: { readonly digest?: { readonly sha256?: string } };
  };
  const evaluationSpecSha256 = subjectTaskDoc.evaluation?.digest?.sha256;
  if (evaluationSpecSha256 === undefined) {
    journalCouldNotGradeLegs(deps, cellKey, "subject Task carries no bound EvaluationSpec digest", evalIndexes);
    return;
  }
  const evaluationSpecBytes = getSealedBytes(deps.workspaceDir, evaluationSpecSha256);

  let prepared: PreparedEvaluationCell;
  try {
    prepared = await deps.venue.prepareEvaluationCell({
      subjectTaskBytes,
      subjectDeliveryBytes,
      resultArtifacts,
      evaluationSpecBytes,
    });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const retryable = retryableFailureFromCause(cause);
    if (retryable === undefined) {
      journalCouldNotGradeLegs(deps, cellKey, detail, evalIndexes);
      return;
    }
    for (const evalIndex of evalIndexes) {
      journalEvaluationFailure(deps, {
        cellKey,
        dispatch,
        evalIndex,
        evaluationAttempt: evaluationAttempts[evalIndex] ?? 1,
        evaluator: deps.venue.evaluators[evalIndex - 1]!.id,
        detail,
        retryable,
      });
    }
    return;
  }
  const storedTaskSha256 = putSealedBytes(deps.workspaceDir, prepared.taskBytes);
  if (storedTaskSha256 !== prepared.taskSha256) {
    refuse(
      "record-integrity",
      "evaluation-task",
      `prepared evaluation Task digest ${prepared.taskSha256} does not match its exact bytes (${storedTaskSha256})`,
    );
  }

  for (const evalIndex of evalIndexes) {
    const evaluationAttempt = evaluationAttempts[evalIndex] ?? 1;
    try {
      await dispatchEvaluation(deps, cellKey, dispatch, prepared, evalIndex, evaluationAttempt);
    } catch (cause) {
      const evaluator = deps.venue.evaluators[evalIndex - 1];
      const detail = cause instanceof Error ? cause.message : String(cause);
      const retryable = retryableFailureFromCause(cause);
      journalEvaluationFailure(deps, {
        cellKey,
        dispatch,
        evalTaskSha256: prepared.taskSha256,
        evaluator: evaluator!.id,
        evalIndex,
        evaluationAttempt,
        detail,
        ...(retryable === undefined ? {} : { retryable }),
      });
    }
  }
}

/** A harvested Delivery: the subject bytes the evaluation leg grades, plus its output artifacts. */
interface HarvestedDelivery {
  readonly deliveryBytes: Uint8Array;
  readonly resultArtifacts: readonly { readonly name: string; readonly bytes: Uint8Array }[];
}

/**
 * Fetches a delivered attempt's Delivery and output artifacts from the backend and journals the
 * `delivery` entry. Returns `undefined` after journaling a could-not-grade terminal for every leg
 * in `evalIndexes` when the delivery cannot be harvested at all.
 *
 * Every step reads the attempt's own already-durable bytes and stores them content-addressed, so
 * running this a second time for the same attempt re-derives the identical digests and the
 * identical journal entry — nothing is re-minted. That is what lets `driveEvaluationCatchUp` heal
 * a cell whose `delivery` entry was lost to a crash (issue #3081) without touching the solve leg.
 */
async function harvestDelivery(
  deps: DriveDeps,
  cellKey: string,
  dispatch: number,
  attempt: string,
  evalIndexes: readonly number[],
): Promise<HarvestedDelivery | undefined> {
  const refs = await deps.backend.deliveries(attempt as AttemptUri);
  const deliveryRef = refs.at(-1);
  if (deliveryRef === undefined) {
    journalCouldNotGradeLegs(deps, cellKey, "no Delivery recorded for a delivered attempt", evalIndexes);
    return undefined;
  }
  const deliveryBytes = await deps.backend.fetchDelivery(deliveryRef);
  const deliverySha256 = putSealedBytes(deps.workspaceDir, deliveryBytes);
  const deliveryDoc = recordManagedDeliveryAuthorship(deps, deliverySha256, deliveryBytes);

  if (deps.backend.fetchArtifact === undefined) {
    journalCouldNotGradeLegs(deps, cellKey, "backend does not support fetchArtifact", evalIndexes);
    return undefined;
  }
  const resultArtifacts: { name: string; bytes: Uint8Array }[] = [];
  const journaledOutputs: { name: string; sha256: string }[] = [];
  for (const output of deliveryDoc.outputs) {
    if (output.digest?.sha256 === undefined) continue;
    const bytes = await deps.backend.fetchArtifact({ digest: { sha256: output.digest.sha256 } });
    resultArtifacts.push({ name: output.name, bytes });
    journaledOutputs.push({ name: output.name, sha256: putSealedBytes(deps.workspaceDir, bytes) });
  }

  appendRunJournalEntry(deps.workspaceDir, deps.draftId, {
    kind: "delivery",
    at: deps.liveClock(),
    cellKey,
    dispatch,
    attempt,
    deliverySha256,
    outputs: journaledOutputs,
  });
  return { deliveryBytes, resultArtifacts };
}

/** Fetches a delivered solve cell's outputs from the backend, journals the delivery, then
 * prepares + dispatches its evaluation leg. */
async function driveEvaluationForDelivery(deps: DriveDeps, event: CellStatusEvent): Promise<void> {
  const { cellKey, dispatch } = event;
  const attempt = event.attempt;
  const evalIndexes = allEvalIndexes(deps);
  if (attempt === undefined) {
    journalCouldNotGradeLegs(deps, cellKey, "delivered cell-event carried no attempt reference", evalIndexes);
    return;
  }

  try {
    const harvested = await harvestDelivery(deps, cellKey, dispatch, attempt, evalIndexes);
    if (harvested === undefined) return;
    await prepareAndDispatchEvaluation(
      deps,
      cellKey,
      dispatch,
      harvested.deliveryBytes,
      harvested.resultArtifacts,
      evalIndexes,
      Object.fromEntries(evalIndexes.map((evalIndex) => [evalIndex, 1])),
    );
  } catch (cause) {
    // Reached only from pre-leg work (delivery fetch/journal, spec resolution, prepare) — the
    // per-leg loop inside prepareAndDispatchEvaluation catches its own legs' failures.
    journalCouldNotGradeLegs(deps, cellKey, cause instanceof Error ? cause.message : String(cause), evalIndexes);
  }
}

/**
 * Best-effort task-vs-infrastructure attribution for an "error" terminal (BP-22, plan decision
 * 8). Re-observes the attempt the event named and reads the platform's own derived blame
 * (`snapshot.descriptor.derived.blame` — populated by the launcher's own BlameRule at the
 * attempt's terminal observation: an unmatched exit is "task", `{signal: SIGKILL}` or another
 * infra-side failure is "infrastructure", and a deadline-expiry terminal carries none). Never an
 * event kind other than "error", never an event with no attempt reference (a submit rejection,
 * for instance, has neither) — those return `undefined` without touching the backend at all.
 * Any observe failure is swallowed: blame is a diagnostic enrichment on top of an already-durable
 * journal write, never a reason to slow or fail it — an absent blame stays honestly "unknown".
 */
async function observeBlame(
  deps: DriveDeps,
  event: CellStatusEvent,
): Promise<"task" | "infrastructure" | undefined> {
  if (event.kind !== "error" || event.attempt === undefined) return undefined;
  try {
    const snapshot = await deps.backend.observe(event.attempt as AttemptUri);
    return snapshot.descriptor.derived.blame;
  } catch {
    return undefined;
  }
}

/**
 * Folds a `CellStatusEvent` stream into the run journal, dispatching the evaluation leg
 * in-line on every solve-side `delivered` terminal (module header).
 */
export async function driveCellEvents(
  deps: DriveDeps,
  events: AsyncIterable<CellStatusEvent>,
): Promise<void> {
  requireEvaluatorCoverage(deps);
  for await (const event of events) {
    const blame = await observeBlame(deps, event);
    appendRunJournalEntry(deps.workspaceDir, deps.draftId, {
      kind: "cell-event",
      at: deps.liveClock(),
      event,
      ...(blame !== undefined ? { blame } : {}),
    });
    emitProgress(deps, `${event.cellKey} ${event.kind}`);
    if (event.kind === "delivered") {
      await driveEvaluationForDelivery(deps, event);
    }
  }
}

/** A delivered cell with at least one missing evaluation leg, as folded from the run journal
 * (`./journal.js`'s `evaluationGaps`) — everything needed to re-run only the missing legs
 * without touching the backend for the solve side again (the delivery is already durably
 * stored). */
export interface DeliveredCellGap {
  readonly cellKey: string;
  readonly lastDispatch: number;
  /** Present when the cell's `delivery` journal entry survived — the ordinary gap. Absent only
   * for a cell stranded inside the crash window between the `delivered` cell-event's journal
   * write and the `delivery` entry's (issue #3081); `attempt` is then the handle. */
  readonly deliverySha256?: string;
  /** The delivered cell-event's attempt URI, from the fold. The only route back to the Delivery
   * when `deliverySha256` is absent. */
  readonly attempt?: string;
  readonly deliveryOutputs?: readonly { readonly name: string; readonly sha256: string }[];
  /** The uncovered 1-based leg indexes (ascending) — ONLY these legs are re-run. */
  readonly missingEvalIndexes: readonly number[];
  readonly nextEvaluationAttempts?: Readonly<Record<number, number>>;
}

/**
 * Re-runs only the missing evaluation legs for cells that delivered but never reached a
 * journaled terminal for every leg (interrupted between delivery and verdict, or between
 * verdict-submit and observe). Reads the already-journaled delivery straight from the
 * sealed-bytes store — the solve side is done; nothing here re-dispatches it.
 *
 * A cell killed inside the narrower window between its `delivered` cell-event journal write and
 * its `delivery` journal write (issue #3081) has no journaled delivery to read. Its Delivery is
 * nonetheless durable in the attempt the cell-event named, so that gap is healed by re-entering
 * `harvestDelivery` for that attempt: the sealed Delivery is re-read and re-stored
 * content-addressed, never re-minted, and the missing `delivery` entry is journaled before the
 * evaluation legs run. A repeated resume then finds `deliverySha256` present and takes the
 * ordinary path, so healing converges.
 *
 * Every gap reaching this function terminates: a cell with neither a journaled delivery nor an
 * attempt reference journals could-not-grade for its missing legs rather than being skipped, so
 * resume's accounting and `../operations/run-collect.js`'s cannot disagree about what is
 * outstanding.
 */
export async function driveEvaluationCatchUp(
  deps: DriveDeps,
  gaps: readonly DeliveredCellGap[],
): Promise<void> {
  requireEvaluatorCoverage(deps);
  for (const gap of gaps) {
    try {
      let harvested: HarvestedDelivery | undefined;
      if (gap.deliverySha256 !== undefined) {
        harvested = {
          deliveryBytes: getSealedBytes(deps.workspaceDir, gap.deliverySha256),
          resultArtifacts: (gap.deliveryOutputs ?? []).map((output) => ({
            name: output.name,
            bytes: getSealedBytes(deps.workspaceDir, output.sha256),
          })),
        };
      } else if (gap.attempt === undefined) {
        journalCouldNotGradeLegs(
          deps,
          gap.cellKey,
          "delivered cell has neither a journaled Delivery nor an attempt reference",
          gap.missingEvalIndexes,
        );
        continue;
      } else {
        harvested = await harvestDelivery(
          deps,
          gap.cellKey,
          gap.lastDispatch,
          gap.attempt,
          gap.missingEvalIndexes,
        );
        if (harvested === undefined) continue;
      }
      await prepareAndDispatchEvaluation(
        deps,
        gap.cellKey,
        gap.lastDispatch,
        harvested.deliveryBytes,
        harvested.resultArtifacts,
        gap.missingEvalIndexes,
        gap.nextEvaluationAttempts
          ?? Object.fromEntries(gap.missingEvalIndexes.map((evalIndex) => [evalIndex, 1])),
      );
    } catch (cause) {
      // Pre-leg failure (stored bytes unreadable, delivery re-harvest failed) — fan out so every
      // missing leg terminates.
      journalCouldNotGradeLegs(deps, gap.cellKey, cause instanceof Error ? cause.message : String(cause), gap.missingEvalIndexes);
    }
  }
}
