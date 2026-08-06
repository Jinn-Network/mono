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
 *   durably records every accepted Submission (solve or evaluation) before delegating. It is
 *   bookkeeping only, never a backend substitute: every method except `submit` forwards
 *   unchanged, and `submit` itself still calls straight through to the real backend.
 * - `driveCellEvents` — folds a `CellStatusEvent` stream into the run journal and, on delivery,
 *   runs the evaluation leg synchronously in-line (prepare → seal Submission → submit through
 *   the same proxy → drain → observe → harvest the verdict or record a could-not-grade fact).
 */

import { parseCellKey } from "@jinn-network/benchmarking-records";
import type { CellStatusEvent } from "@jinn-network/benchmarking-run";
import type {
  AttemptUri,
  BackendCapabilities,
  CancelAck,
  DeliveryRef,
  ObservationCursor,
  ObservationSnapshot,
  ReconciliationReport,
  SubmissionAck,
  SubmissionUri,
  TwoPartyEngagement,
} from "@jinn-network/task-execution-backend";
import { sealSubmission, type ProtocolObservation, type ResourceDescriptor } from "@jinn-network/task-execution-protocol";
import { EVALUATION_HARNESS_PIN, type LocalVenue } from "../venue/venue.js";
import { getSealedBytes, putSealedBytes } from "../workspace/sealed-store.js";
import { appendRunJournalEntry } from "./journal.js";
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
  drain(): Promise<void>;
}

export interface RecordingProxyDeps {
  readonly workspaceDir: string;
  readonly draftId: string;
  /** The live, unfrozen clock (see run-quote.ts's own note on why). */
  readonly liveClock: () => string;
}

/**
 * Parses `<...>:<cellKey>:<dispatch>` — the LAST two `:`-delimited segments — out of a
 * Submission's `nonce`. A solve dispatch's nonce IS exactly `<cellKey>:<dispatch>`
 * (`benchmarking-run`'s `launch.ts`); this product's own evaluation Submissions use
 * `eval:<runSha256>:<cellKey>:<dispatch>` (`./drive.ts`'s own `dispatchEvaluation`, below) — a
 * cellKey never itself contains `:`, so the last-two-segments rule reads correctly under both
 * shapes without the proxy needing to know which kind of Submission it is looking at.
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
      if (coord !== undefined) {
        const submissionSha256 = putSealedBytes(deps.workspaceDir, submissionBytes);
        appendRunJournalEntry(deps.workspaceDir, deps.draftId, {
          kind: "submission-accepted",
          at: deps.liveClock(),
          cellKey: coord.cellKey,
          dispatch: coord.dispatch,
          submissionSha256,
        });
      }
      return backend.submit(taskBytes, submissionBytes, engagement);
    },
    observe: (ref) => backend.observe(ref),
    watch: backend.watch === undefined ? undefined : (ref, cursor) => backend.watch!(ref, cursor),
    cancel: backend.cancel === undefined ? undefined : (attempt, reason) => backend.cancel!(attempt, reason),
    recover: (ref) => backend.recover(ref),
    deliveries: (attempt) => backend.deliveries(attempt),
    fetchDelivery: (ref) => backend.fetchDelivery(ref),
    fetchArtifact: backend.fetchArtifact === undefined ? undefined : (descriptor) => backend.fetchArtifact!(descriptor),
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
  /** The live, unfrozen clock — journal timestamps reflect when each event actually happened. */
  readonly liveClock: () => string;
}

function journalCouldNotGrade(
  deps: DriveDeps,
  cellKey: string,
  detail: string,
  extra: { evalTaskSha256?: string; evalAttempt?: string } = {},
): void {
  appendRunJournalEntry(deps.workspaceDir, deps.draftId, {
    kind: "evaluation",
    at: deps.liveClock(),
    cellKey,
    evaluationTerminal: "could-not-grade",
    detail,
    ...(extra.evalTaskSha256 !== undefined ? { evalTaskSha256: extra.evalTaskSha256 } : {}),
    ...(extra.evalAttempt !== undefined ? { evalAttempt: extra.evalAttempt } : {}),
  });
}

/** Seals + submits + watches the evaluation leg for a prepared evaluation cell (module header). */
async function dispatchEvaluation(
  deps: DriveDeps,
  cellKey: string,
  dispatch: number,
  prepared: { readonly taskBytes: Uint8Array; readonly taskSha256: string },
): Promise<void> {
  const idempotencyKey = `eval:${deps.runSha256}:${cellKey}:${dispatch}`;
  const submissionUri = deterministicUuidUri(idempotencyKey);
  const deadline = new Date(Date.parse(deps.liveClock()) + deps.cellWindowMs).toISOString();
  const evalSubmissionBytes = sealSubmission({
    protocol: "https://spec.jinn.network/profiles/task-execution/v1",
    submission: submissionUri,
    task: { digest: { sha256: prepared.taskSha256 } },
    requester: deps.owner,
    nonce: idempotencyKey,
    idempotencyKey,
    deadline,
    requirements: { harness: EVALUATION_HARNESS_PIN },
  });

  const ack = await deps.backend.submit(prepared.taskBytes, evalSubmissionBytes);
  if (!ack.accepted) {
    journalCouldNotGrade(deps, cellKey, ack.error.detail ?? ack.error.category, { evalTaskSha256: prepared.taskSha256 });
    return;
  }
  await deps.backend.drain();
  const snapshot = await deps.backend.observe(ack.submission);
  const evalAttempt = snapshot.descriptor.attempt;
  if (snapshot.descriptor.derived.state !== "delivered") {
    journalCouldNotGrade(
      deps,
      cellKey,
      `evaluation attempt terminal state: ${snapshot.descriptor.derived.state}`,
      { evalTaskSha256: prepared.taskSha256, ...(evalAttempt !== undefined ? { evalAttempt } : {}) },
    );
    return;
  }

  const refs = await deps.backend.deliveries(evalAttempt as AttemptUri);
  const deliveryRef = refs.at(-1);
  if (deliveryRef === undefined) {
    journalCouldNotGrade(deps, cellKey, "evaluation attempt delivered but no Delivery was recorded", {
      evalTaskSha256: prepared.taskSha256,
      evalAttempt,
    });
    return;
  }
  const deliveryBytes = await deps.backend.fetchDelivery(deliveryRef);
  const delivery = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(deliveryBytes)) as {
    readonly outputs: readonly { readonly name: string; readonly digest?: { readonly sha256?: string } }[];
  };
  const verdictOutput = delivery.outputs.find((output) => output.name === "verdict");
  if (verdictOutput?.digest?.sha256 === undefined) {
    journalCouldNotGrade(deps, cellKey, "evaluation delivery carries no verdict output", {
      evalTaskSha256: prepared.taskSha256,
      evalAttempt,
    });
    return;
  }
  if (deps.backend.fetchArtifact === undefined) {
    journalCouldNotGrade(deps, cellKey, "backend does not support fetchArtifact", {
      evalTaskSha256: prepared.taskSha256,
      evalAttempt,
    });
    return;
  }
  const envelopeBytes = await deps.backend.fetchArtifact({ digest: { sha256: verdictOutput.digest.sha256 } });
  const verdictSha256 = putSealedBytes(deps.workspaceDir, envelopeBytes);

  appendRunJournalEntry(deps.workspaceDir, deps.draftId, {
    kind: "evaluation",
    at: deps.liveClock(),
    cellKey,
    evalTaskSha256: prepared.taskSha256,
    evalAttempt,
    verdictSha256,
  });
}

/**
 * The tail shared by a fresh delivery and a resumed (already-journaled) one: resolve the
 * subject Task's bound EvaluationSpec, prepare the evaluation cell, and dispatch it.
 */
async function prepareAndDispatchEvaluation(
  deps: DriveDeps,
  cellKey: string,
  dispatch: number,
  subjectDeliveryBytes: Uint8Array,
  resultArtifacts: readonly { readonly name: string; readonly bytes: Uint8Array }[],
): Promise<void> {
  const taskDigestHex = parseCellKey(cellKey).taskDigest;
  const subjectTaskBytes = getSealedBytes(deps.workspaceDir, taskDigestHex);
  const subjectTaskDoc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(subjectTaskBytes)) as {
    readonly evaluation?: { readonly digest?: { readonly sha256?: string } };
  };
  const evaluationSpecSha256 = subjectTaskDoc.evaluation?.digest?.sha256;
  if (evaluationSpecSha256 === undefined) {
    journalCouldNotGrade(deps, cellKey, "subject Task carries no bound EvaluationSpec digest");
    return;
  }
  const evaluationSpecBytes = getSealedBytes(deps.workspaceDir, evaluationSpecSha256);

  const prepared = deps.venue.prepareEvaluationCell({
    subjectTaskBytes,
    subjectDeliveryBytes,
    resultArtifacts,
    evaluationSpecBytes,
  });

  await dispatchEvaluation(deps, cellKey, dispatch, prepared);
}

/** Fetches a delivered solve cell's outputs from the backend, journals the delivery, then
 * prepares + dispatches its evaluation leg. */
async function driveEvaluationForDelivery(deps: DriveDeps, event: CellStatusEvent): Promise<void> {
  const { cellKey, dispatch } = event;
  const attempt = event.attempt;
  if (attempt === undefined) {
    journalCouldNotGrade(deps, cellKey, "delivered cell-event carried no attempt reference");
    return;
  }

  try {
    const refs = await deps.backend.deliveries(attempt as AttemptUri);
    const deliveryRef = refs.at(-1);
    if (deliveryRef === undefined) {
      journalCouldNotGrade(deps, cellKey, "no Delivery recorded for a delivered attempt");
      return;
    }
    const deliveryBytes = await deps.backend.fetchDelivery(deliveryRef);
    const deliverySha256 = putSealedBytes(deps.workspaceDir, deliveryBytes);
    const deliveryDoc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(deliveryBytes)) as {
      readonly outputs: readonly { readonly name: string; readonly digest?: { readonly sha256?: string } }[];
    };

    if (deps.backend.fetchArtifact === undefined) {
      journalCouldNotGrade(deps, cellKey, "backend does not support fetchArtifact");
      return;
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

    await prepareAndDispatchEvaluation(deps, cellKey, dispatch, deliveryBytes, resultArtifacts);
  } catch (cause) {
    journalCouldNotGrade(deps, cellKey, cause instanceof Error ? cause.message : String(cause));
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
  for await (const event of events) {
    appendRunJournalEntry(deps.workspaceDir, deps.draftId, { kind: "cell-event", at: deps.liveClock(), event });
    if (event.kind === "delivered") {
      await driveEvaluationForDelivery(deps, event);
    }
  }
}

/** A delivered-but-unevaluated cell, as folded from the run journal (`./journal.js`'s
 * `deliveredWithoutEvaluation`) — everything needed to re-run only the evaluation leg without
 * touching the backend for the solve side again (the delivery is already durably stored). */
export interface DeliveredCellGap {
  readonly cellKey: string;
  readonly lastDispatch: number;
  readonly deliverySha256: string;
  readonly deliveryOutputs?: readonly { readonly name: string; readonly sha256: string }[];
}

/**
 * Re-runs only the evaluation leg for cells that delivered but never reached an evaluation
 * entry (interrupted between delivery and verdict, or between verdict-submit and observe). Reads
 * the already-journaled delivery straight from the sealed-bytes store — the solve side is done;
 * nothing here re-contacts the backend for it.
 */
export async function driveEvaluationCatchUp(
  deps: DriveDeps,
  gaps: readonly DeliveredCellGap[],
): Promise<void> {
  for (const gap of gaps) {
    try {
      const deliveryBytes = getSealedBytes(deps.workspaceDir, gap.deliverySha256);
      const resultArtifacts = (gap.deliveryOutputs ?? []).map((output) => ({
        name: output.name,
        bytes: getSealedBytes(deps.workspaceDir, output.sha256),
      }));
      await prepareAndDispatchEvaluation(deps, gap.cellKey, gap.lastDispatch, deliveryBytes, resultArtifacts);
    } catch (cause) {
      journalCouldNotGrade(deps, gap.cellKey, cause instanceof Error ? cause.message : String(cause));
    }
  }
}
