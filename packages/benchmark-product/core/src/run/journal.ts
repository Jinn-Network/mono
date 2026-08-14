/**
 * The per-run append-only cell-status journal (BP-12, M1 composition dossier §1).
 *
 * Distinct from the workspace's audit journal (`../audit/journal.ts`, spec §4.4), which
 * attributes *operations* to principals. This journal is a durable record of what the driver
 * (`./drive.ts`) observed and did while dispatching one Run's cells and their evaluation
 * legs — the crash-safe substrate `runResume` folds to recompute `outstanding` (spec §4.1
 * `running --resume--> running`: "crash-safe resumption via the records' cell idempotency
 * keys"). One journal per draftId (`runJournalPath`), JSON Lines, entries never rewritten.
 *
 * Seven entry kinds:
 * - `launched` — the run driver started (one per `runLaunch` call).
 * - `cell-event` — a solve-side `CellStatusEvent` from `launchAndWatch`/`resumeRun`, verbatim.
 *   Optionally carries `blame` (BP-22): for an "error" terminal, the platform-derived
 *   task-vs-infrastructure attribution `../run/drive.ts` best-effort observed at journal-write
 *   time (`"task" | "infrastructure"`, absent when unobservable — never a reason to fail the
 *   write it enriches).
 * - `submission-accepted` — the exact sealed Submission bytes were stored, keyed by dispatch.
 * - `delivery` — the exact sealed Delivery bytes were stored for a dispatch's accounted attempt.
 * - `evaluation` — the evaluation leg reached a terminal (a verdict, or a could-not-grade fact).
 * - `cancel-requested` (BP-22) — `run.cancel` recorded a cancellation request. Written exactly
 *   once per run, alongside (never instead of) the durable cancel marker
 *   (`./cancel-marker.ts`) — the marker is the fact other operations gate on; this entry is the
 *   audit-trail echo of it inside the same journal every other cell activity lives in.
 * - `closed` — `run.collect` OR `run.cancel` sealed the Matrix.
 */

import { z } from "zod";
import { PRODUCT_ERROR_CODES, refuse, refuseWithIssues, type ProductIssue } from "../errors.js";
import { appendFsyncedLineSync, readTextIfExistsSync } from "../fs/atomic.js";
import { runJournalPath } from "../workspace/layout.js";

const Rfc3339Schema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
  "must be an RFC 3339 timestamp",
);

const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/, "must be a lowercase sha256 hex digest");
const ProductErrorEnvelopeSchema = z.object({
  code: z.enum(PRODUCT_ERROR_CODES),
  detail: z.string(),
  issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});

/** Mirrors `@jinn-network/benchmarking-run`'s `CellStatusEvent` (launch.ts) — not itself a zod schema there. */
const CellStatusEventSchema = z.object({
  cellKey: z.string(),
  armId: z.string(),
  replicate: z.number().int(),
  dispatch: z.number().int(),
  kind: z.enum(["dispatch", "claimed", "delivered", "judged", "cancelled", "error"]),
  attempt: z.string().optional(),
  submission: z.string().optional(),
  submissionDigest: z.string().optional(),
  detail: z.string().optional(),
  replaceable: z.boolean().optional(),
  replaceableReason: z.enum(["expired", "unscorable", "exclusion-hit"]).optional(),
  cancelledRun: z.boolean().optional(),
});

export type CellStatusEventLike = z.infer<typeof CellStatusEventSchema>;

export const RunJournalEntrySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("launched"), at: Rfc3339Schema }),
  z.object({
    kind: z.literal("driver-started"),
    at: Rfc3339Schema,
    operation: z.enum(["launch", "resume"]),
    generation: z.string().min(1),
  }),
  z.object({
    kind: z.literal("driver-succeeded"),
    at: Rfc3339Schema,
    operation: z.enum(["launch", "resume"]),
    generation: z.string().min(1),
  }),
  z.object({
    kind: z.literal("driver-failed"),
    at: Rfc3339Schema,
    operation: z.enum(["launch", "resume"]),
    generation: z.string().min(1),
    error: ProductErrorEnvelopeSchema,
  }),
  z.object({
    kind: z.literal("cell-event"),
    at: Rfc3339Schema,
    event: CellStatusEventSchema,
    /** Best-effort task-vs-infrastructure attribution for an "error" terminal (BP-22). Absent
     * whenever the event isn't an "error" terminal, or the backend observation that would have
     * supplied it failed or was never attempted. */
    blame: z.enum(["task", "infrastructure"]).optional(),
  }),
  z.object({
    /** Persisted before backend.submit. This is the prospective capture boundary: a capture
     * failure leaves no backend side effect to reconstruct later. */
    kind: z.literal("submission-captured"),
    at: Rfc3339Schema,
    cellKey: z.string(),
    armId: z.string(),
    replicate: z.number().int(),
    dispatch: z.number().int().positive(),
    submissionSha256: Sha256HexSchema,
    /** Public-source receipt, required only for PUB-12 prospective public runs. */
    publicationSourceSequence: z.string().regex(/^\d{16}$/).optional(),
    publicationEntrySha256: Sha256HexSchema.optional(),
  }),
  z.object({
    kind: z.literal("submission-accepted"),
    at: Rfc3339Schema,
    cellKey: z.string(),
    dispatch: z.number().int().positive(),
    submissionSha256: Sha256HexSchema,
    /** Exact product-CAS artifact containing the real run-pinning gate result for this solve
     * Submission. Optional for evaluation legs, legacy entries, and accepted backends that did
     * not expose a verification gate. */
    pinningEvidenceSha256: Sha256HexSchema.optional(),
    /** Which leg's Submission this is (BP-21). Optional: legacy entries carry no leg. */
    leg: z.enum(["solve", "evaluation"]).optional(),
  }),
  z.object({
    /** Append-only enrichment captured by the post-ack backend proxy. Kept separate from
     * `submission-accepted` so LaunchCapturePort remains the sole acceptance writer. */
    kind: z.literal("submission-pinning-evidence"),
    at: Rfc3339Schema,
    cellKey: z.string(),
    dispatch: z.number().int().positive(),
    submissionSha256: Sha256HexSchema,
    pinningEvidenceSha256: Sha256HexSchema,
  }),
  z.object({
    /** Exact sealed observation archive formed from the backend's accepted snapshot. */
    kind: z.literal("observation-accepted"),
    at: Rfc3339Schema,
    cellKey: z.string(),
    armId: z.string(),
    replicate: z.number().int(),
    dispatch: z.number().int().positive(),
    submissionSha256: Sha256HexSchema,
    observationArchiveSha256: Sha256HexSchema,
    attempt: z.string().min(1),
  }),
  z.object({
    kind: z.literal("delivery"),
    at: Rfc3339Schema,
    cellKey: z.string(),
    dispatch: z.number().int().positive(),
    attempt: z.string(),
    deliverySha256: Sha256HexSchema,
    outputs: z.array(z.object({ name: z.string(), sha256: Sha256HexSchema })),
  }),
  z.object({
    kind: z.literal("evaluation"),
    at: Rfc3339Schema,
    cellKey: z.string(),
    // Optional (a divergence from the brief's unmarked field, deliberate): a could-not-grade
    // outcome can occur BEFORE an evaluation Task was ever derived (no delivery to grade, no
    // EvaluationSpec bound) — recording a placeholder digest there would misrepresent the
    // journal as naming a real evaluation Task that was never actually prepared.
    evalTaskSha256: Sha256HexSchema.optional(),
    /** Exact evaluation Delivery bytes in the product CAS (BP-40). Optional for pre-BP-40
     * journals and for failures that terminalize before an evaluation Delivery exists. */
    evalDeliverySha256: Sha256HexSchema.optional(),
    evalAttempt: z.string().optional(),
    verdictSha256: Sha256HexSchema.optional(),
    evaluationTerminal: z.literal("could-not-grade").optional(),
    detail: z.string().optional(),
    /** The evaluator identity IRI this leg named via `EVALUATOR_REQUIREMENT_KEY` (BP-21).
     * Optional: legacy single-evaluator entries carry neither field. */
    evaluator: z.string().optional(),
    /** 1-based evaluation-leg index within `policy.evaluation.minVerdicts` (BP-21). A fold
     * treats an entry without one as leg 1 (the only leg a legacy journal ever ran). */
    evalIndex: z.number().int().min(1).optional(),
  }),
  /** `run.cancel` recorded a cancellation request (BP-22) — written once per run, alongside the
   * durable cancel marker (`./cancel-marker.ts`). Carries no per-cell accounting; the fold below
   * ignores it exactly like "launched". */
  z.object({ kind: z.literal("cancel-requested"), at: Rfc3339Schema }),
  z.object({ kind: z.literal("closed"), at: Rfc3339Schema, matrixSha256: Sha256HexSchema }),
]).superRefine((entry, context) => {
  if (entry.kind === "cell-event" && entry.blame !== undefined && entry.event.kind !== "error") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["blame"],
      message: "blame is only valid for an error cell-event",
    });
  }
});

export type RunJournalEntry = z.infer<typeof RunJournalEntrySchema>;

function issuesFromZodError(error: z.ZodError): ProductIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join(".") : "(root)",
    message: issue.message,
  }));
}

/** Validates then appends exactly one fsynced JSONL line to the run journal for `draftId`. */
export function appendRunJournalEntry(workspaceDir: string, draftId: string, entry: RunJournalEntry): void {
  const result = RunJournalEntrySchema.safeParse(entry);
  if (!result.success) {
    refuseWithIssues("validation", issuesFromZodError(result.error));
  }
  appendFsyncedLineSync(runJournalPath(workspaceDir, draftId), JSON.stringify(result.data));
}

/**
 * Returns every entry in file order. An absent or empty journal returns `[]`. A line that is
 * not JSON, or that fails the schema, refuses `"journal-integrity"` naming the zero-based line
 * index (e.g. `runs.<draftId>.3`).
 */
export function readRunJournalEntries(workspaceDir: string, draftId: string): RunJournalEntry[] {
  const text = readTextIfExistsSync(runJournalPath(workspaceDir, draftId));
  if (text === "") return [];

  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();

  return lines.map((line, index): RunJournalEntry => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      refuse("journal-integrity", `runs.${draftId}.${index}`, `line ${index} is not valid JSON`);
    }
    const result = RunJournalEntrySchema.safeParse(parsed);
    if (!result.success) {
      refuse("journal-integrity", `runs.${draftId}.${index}`, `line ${index} fails the run journal entry schema`);
    }
    return result.data;
  });
}

/**
 * The coarse mechanical status of one cell. `foldRunJournal` only ever produces the six
 * activity-derived values below for a cell it has SOME journal entry for; `"pending"` — an
 * expected cell with no journal entry at all yet — is a value callers with the expected cell
 * set (`run-status.ts`, `run-collect.ts`) synthesize themselves for cells absent from the fold,
 * never something this module returns.
 */
export type CellStatus = "pending" | "dispatched" | "claimed" | "delivered" | "judged" | "failed" | "expired" | "cancelled";

/** One journaled verdict, in journal order (BP-21). `evaluator`/`evalIndex` are absent on
 * verdicts folded from legacy single-evaluator entries. */
export interface CellVerdictFold {
  readonly sha256: string;
  readonly evaluator?: string;
  readonly evalIndex?: number;
}

export interface CellJournalFold {
  readonly cellKey: string;
  readonly armId: string;
  readonly replicate: number;
  readonly status: CellStatus;
  /** Count of distinct "dispatch" cell-events (§7.4 replacement lineage). */
  readonly dispatches: number;
  /** The highest dispatch number seen for this cell. */
  readonly lastDispatch: number;
  readonly attempt?: string;
  readonly submissionSha256?: string;
  readonly pinningEvidenceSha256?: string;
  readonly deliverySha256?: string;
  readonly deliveryOutputs?: readonly { readonly name: string; readonly sha256: string }[];
  /** Every journaled verdict for the current dispatch, in journal order (BP-21). */
  readonly verdicts: readonly CellVerdictFold[];
  /** The FIRST verdict's sha256 — the stable single-verdict bridge for downstream consumers
   * (`run-status.ts`, `assembly-ports.ts`) that predate multi-leg evaluation. */
  readonly verdictSha256?: string;
  /** Set when at least one evaluation leg journaled could-not-grade (with multiple legs this
   * is NOT "the evaluation failed" — other legs may have journaled verdicts; consult
   * `verdicts` and `completedEvalIndexes` for per-leg accounting). */
  readonly evaluationTerminal?: "could-not-grade";
  /** Ascending, deduplicated 1-based leg indexes with a terminal (a verdict OR a
   * could-not-grade entry). Entries without an evalIndex count as index 1 (legacy folds). */
  readonly completedEvalIndexes: readonly number[];
  readonly detail?: string;
  /** The most recent task-vs-infrastructure attribution journaled for this cell's CURRENT
   * dispatch (BP-22) — set from a cell-event entry's `blame`, reset (to absent) on a fresh
   * dispatch alongside the other per-dispatch fields. Absent whenever no "error" terminal on
   * this dispatch carried an observable blame. */
  readonly blame?: "task" | "infrastructure";
}

/** Complete per-dispatch capture; unlike `CellJournalFold` this never discards replacement
 * history when a newer dispatch starts. Consumers assembling profile accounting use this API. */
export interface DispatchLineageFold {
  readonly cellKey: string;
  readonly armId: string;
  readonly replicate: number;
  readonly dispatch: number;
  readonly submissionSha256?: string;
  readonly acceptedSubmissionSha256?: string;
  readonly pinningEvidenceSha256?: string;
  readonly observationArchiveSha256?: string;
  readonly attempt?: string;
  readonly deliverySha256?: string;
  readonly verdicts: readonly CellVerdictFold[];
  readonly status?: CellStatus;
}

interface MutableFold {
  cellKey: string;
  armId: string;
  replicate: number;
  dispatches: number;
  seenDispatches: Set<number>;
  lastDispatch: number;
  attempt?: string;
  lastKind?: CellStatusEventLike["kind"];
  replaceableReason?: CellStatusEventLike["replaceableReason"];
  detail?: string;
  submissionSha256?: string;
  pinningEvidenceSha256?: string;
  deliverySha256?: string;
  deliveryOutputs?: { name: string; sha256: string }[];
  verdicts: CellVerdictFold[];
  evaluationTerminal?: "could-not-grade";
  completedEvalIndexes: Set<number>;
  blame?: "task" | "infrastructure";
}

function statusFor(fold: MutableFold): CellStatus {
  if (fold.verdicts.length > 0) return "judged";
  switch (fold.lastKind) {
    case "dispatch":
      return "dispatched";
    case "claimed":
      return "claimed";
    case "delivered":
      return "delivered";
    case "judged":
      return "judged";
    case "cancelled":
      return "cancelled";
    case "error":
      return fold.replaceableReason === "expired" ? "expired" : "failed";
    default:
      // A cell with journal entries but no cell-event yet (e.g. a submission-accepted entry
      // whose dispatch cell-event has not landed) is honestly "dispatched" — a submission was
      // at least accepted for it.
      return "dispatched";
  }
}

/** Folds a run journal's entries into one status per cell, keyed by cellKey. */
export function foldRunJournal(entries: readonly RunJournalEntry[]): Map<string, CellJournalFold> {
  const byCell = new Map<string, MutableFold>();
  const ensure = (cellKey: string, armId: string, replicate: number): MutableFold => {
    const existing = byCell.get(cellKey);
    if (existing !== undefined) return existing;
    const fresh: MutableFold = {
      cellKey,
      armId,
      replicate,
      dispatches: 0,
      seenDispatches: new Set(),
      lastDispatch: 0,
      verdicts: [],
      completedEvalIndexes: new Set(),
    };
    byCell.set(cellKey, fresh);
    return fresh;
  };

  for (const entry of entries) {
    if (entry.kind === "submission-captured") {
      const fold = ensure(entry.cellKey, entry.armId, entry.replicate);
      if (entry.dispatch > fold.lastDispatch) fold.lastDispatch = entry.dispatch;
      fold.seenDispatches.add(entry.dispatch);
      fold.dispatches = fold.seenDispatches.size;
      if (fold.submissionSha256 !== entry.submissionSha256) {
        fold.pinningEvidenceSha256 = undefined;
      }
      fold.submissionSha256 = entry.submissionSha256;
    } else if (entry.kind === "cell-event") {
      const event = entry.event;
      const fold = ensure(event.cellKey, event.armId, event.replicate);
      if (event.dispatch > fold.lastDispatch) fold.lastDispatch = event.dispatch;
      if (event.attempt !== undefined) fold.attempt = event.attempt;
      fold.lastKind = event.kind;
      if (event.kind === "dispatch") {
        fold.seenDispatches.add(event.dispatch);
        fold.dispatches = fold.seenDispatches.size;
        // A fresh dispatch starts over: any prior terminal accounting described the earlier attempt.
        fold.replaceableReason = undefined;
        fold.detail = undefined;
        fold.deliverySha256 = undefined;
        fold.deliveryOutputs = undefined;
        fold.verdicts = [];
        fold.evaluationTerminal = undefined;
        fold.completedEvalIndexes = new Set();
        fold.blame = undefined;
      } else {
        fold.replaceableReason = event.replaceableReason;
        if (event.detail !== undefined) fold.detail = event.detail;
        // Set from THIS entry's own blame (BP-22) — never inherited past a fresh dispatch
        // (reset above), and never cleared by a later cell-event on the same dispatch that
        // simply did not carry one (e.g. this entry's own blame observation failed).
        if (entry.blame !== undefined) fold.blame = entry.blame;
      }
    } else if (entry.kind === "submission-accepted") {
      const fold = ensure(entry.cellKey, "", 0);
      const sameCapturedSubmission = fold.submissionSha256 === entry.submissionSha256;
      if (entry.dispatch > fold.lastDispatch) fold.lastDispatch = entry.dispatch;
      // Acceptance itself proves this dispatch exists even if the process dies before the
      // generator yields its corresponding cell-event. Count by dispatch id so the later event
      // cannot double-count it.
      fold.seenDispatches.add(entry.dispatch);
      fold.dispatches = fold.seenDispatches.size;
      // `submissionSha256` is the SOLVE Submission's digest. An entry marked `leg: "evaluation"`
      // must not overwrite it (pre-BP-21, the evaluation Submission's entry clobbered the solve
      // digest here — leg-less legacy entries keep that last-wins behavior verbatim, since a
      // legacy journal offers no way to tell the two legs apart).
      if (entry.leg !== "evaluation") {
        fold.submissionSha256 = entry.submissionSha256;
        // A fresh solve acceptance without proof must clear any earlier dispatch's proof. This
        // makes missing evidence stay missing instead of inheriting a prior match.
        if (entry.pinningEvidenceSha256 !== undefined) {
          fold.pinningEvidenceSha256 = entry.pinningEvidenceSha256;
        } else if (!sameCapturedSubmission) {
          fold.pinningEvidenceSha256 = undefined;
        }
      }
    } else if (entry.kind === "submission-pinning-evidence") {
      const fold = ensure(entry.cellKey, "", 0);
      if (entry.dispatch > fold.lastDispatch) fold.lastDispatch = entry.dispatch;
      fold.seenDispatches.add(entry.dispatch);
      fold.dispatches = fold.seenDispatches.size;
      fold.submissionSha256 = entry.submissionSha256;
      fold.pinningEvidenceSha256 = entry.pinningEvidenceSha256;
    } else if (entry.kind === "delivery") {
      const fold = ensure(entry.cellKey, "", 0);
      fold.deliverySha256 = entry.deliverySha256;
      fold.deliveryOutputs = entry.outputs;
      if (entry.attempt !== undefined) fold.attempt = entry.attempt;
    } else if (entry.kind === "evaluation") {
      const fold = ensure(entry.cellKey, "", 0);
      if (entry.verdictSha256 !== undefined) {
        fold.verdicts.push({
          sha256: entry.verdictSha256,
          ...(entry.evaluator !== undefined ? { evaluator: entry.evaluator } : {}),
          ...(entry.evalIndex !== undefined ? { evalIndex: entry.evalIndex } : {}),
        });
      }
      if (entry.evaluationTerminal !== undefined) fold.evaluationTerminal = entry.evaluationTerminal;
      // Either terminal (verdict or could-not-grade) completes its leg. Legacy entries without
      // an evalIndex count as leg 1 — the only leg a pre-BP-21 journal ever ran.
      fold.completedEvalIndexes.add(entry.evalIndex ?? 1);
      if (entry.detail !== undefined) fold.detail = entry.detail;
    }
    // "launched", "cancel-requested", and "closed" carry no per-cell accounting.
  }

  const result = new Map<string, CellJournalFold>();
  for (const [cellKey, fold] of byCell) {
    result.set(cellKey, {
      cellKey: fold.cellKey,
      armId: fold.armId,
      replicate: fold.replicate,
      status: statusFor(fold),
      dispatches: fold.dispatches,
      lastDispatch: fold.lastDispatch,
      ...(fold.attempt !== undefined ? { attempt: fold.attempt } : {}),
      ...(fold.submissionSha256 !== undefined ? { submissionSha256: fold.submissionSha256 } : {}),
      ...(fold.pinningEvidenceSha256 !== undefined
        ? { pinningEvidenceSha256: fold.pinningEvidenceSha256 }
        : {}),
      ...(fold.deliverySha256 !== undefined ? { deliverySha256: fold.deliverySha256 } : {}),
      ...(fold.deliveryOutputs !== undefined ? { deliveryOutputs: fold.deliveryOutputs } : {}),
      verdicts: fold.verdicts,
      ...(fold.verdicts[0] !== undefined ? { verdictSha256: fold.verdicts[0].sha256 } : {}),
      ...(fold.evaluationTerminal !== undefined ? { evaluationTerminal: fold.evaluationTerminal } : {}),
      completedEvalIndexes: [...fold.completedEvalIndexes].sort((a, b) => a - b),
      ...(fold.detail !== undefined ? { detail: fold.detail } : {}),
      ...(fold.blame !== undefined ? { blame: fold.blame } : {}),
    });
  }
  return result;
}

/**
 * Fold every observed dispatch without replacing the older record. `foldRunJournal` intentionally
 * retains its historical "current dispatch only" behavior for Matrix/status callers; this
 * companion fold is the profile accounting view.
 */
export function foldRunJournalLineage(entries: readonly RunJournalEntry[]): Map<string, readonly DispatchLineageFold[]> {
  type Mutable = {
    cellKey: string; armId: string; replicate: number; dispatch: number;
    submissionSha256?: string; acceptedSubmissionSha256?: string; pinningEvidenceSha256?: string; observationArchiveSha256?: string;
    attempt?: string; deliverySha256?: string; verdicts: CellVerdictFold[]; status?: CellStatus;
  };
  const byCell = new Map<string, Map<number, Mutable>>();
  const ensure = (cellKey: string, dispatch: number, armId = "unknown", replicate = 0): Mutable => {
    const byDispatch = byCell.get(cellKey) ?? new Map<number, Mutable>();
    byCell.set(cellKey, byDispatch);
    const existing = byDispatch.get(dispatch);
    if (existing !== undefined) return existing;
    const value: Mutable = { cellKey, armId, replicate, dispatch, verdicts: [] };
    byDispatch.set(dispatch, value);
    return value;
  };
  for (const entry of entries) {
    if (entry.kind === "submission-captured") {
      ensure(entry.cellKey, entry.dispatch, entry.armId, entry.replicate).submissionSha256 = entry.submissionSha256;
    } else if (entry.kind === "submission-accepted" && entry.leg !== "evaluation") {
      ensure(entry.cellKey, entry.dispatch).acceptedSubmissionSha256 = entry.submissionSha256;
    } else if (entry.kind === "submission-pinning-evidence") {
      const fold = ensure(entry.cellKey, entry.dispatch);
      fold.submissionSha256 = entry.submissionSha256;
      fold.pinningEvidenceSha256 = entry.pinningEvidenceSha256;
    } else if (entry.kind === "observation-accepted") {
      const fold = ensure(entry.cellKey, entry.dispatch, entry.armId, entry.replicate);
      fold.observationArchiveSha256 = entry.observationArchiveSha256;
      fold.attempt = entry.attempt;
    } else if (entry.kind === "delivery") {
      const fold = ensure(entry.cellKey, entry.dispatch);
      fold.deliverySha256 = entry.deliverySha256;
      fold.attempt = entry.attempt;
      fold.status = "delivered";
    } else if (entry.kind === "evaluation") {
      // Evaluation entries name the active dispatch only implicitly. Associate with the newest
      // known dispatch for this cell, matching the legacy current-dispatch fold.
      const dispatches = byCell.get(entry.cellKey);
      const latest = dispatches === undefined ? undefined : [...dispatches.keys()].sort((a, b) => b - a)[0];
      if (latest !== undefined && entry.verdictSha256 !== undefined) {
        const fold = ensure(entry.cellKey, latest);
        fold.verdicts.push({ sha256: entry.verdictSha256, ...(entry.evaluator === undefined ? {} : { evaluator: entry.evaluator }), ...(entry.evalIndex === undefined ? {} : { evalIndex: entry.evalIndex }) });
        fold.status = "judged";
      }
    } else if (entry.kind === "cell-event") {
      const fold = ensure(entry.event.cellKey, entry.event.dispatch, entry.event.armId, entry.event.replicate);
      if (entry.event.attempt !== undefined) fold.attempt = entry.event.attempt;
      if (entry.event.kind === "error") fold.status = entry.event.replaceableReason === "expired" ? "expired" : "failed";
      else fold.status = entry.event.kind === "dispatch" ? "dispatched" : entry.event.kind === "claimed" ? "claimed" : entry.event.kind === "cancelled" ? "cancelled" : entry.event.kind === "judged" ? "judged" : entry.event.kind === "delivered" ? "delivered" : fold.status;
    }
  }
  return new Map([...byCell.entries()].map(([cellKey, dispatches]) => [
    cellKey,
    [...dispatches.values()].sort((left, right) => left.dispatch - right.dispatch).map((value) => ({ ...value, verdicts: value.verdicts })),
  ]));
}

/** A minimal expected-cell coordinate — matches `benchmarking-records`'s `CellCoord`. */
export interface ExpectedCellCoord {
  readonly cellKey: string;
  readonly armId: string;
  readonly replicate: number;
  readonly taskDigest: string;
}

/** The shape `resumeRun`'s `opts.outstanding` requires (`@jinn-network/benchmarking-run`). */
export interface OutstandingCell {
  readonly cellKey: string;
  readonly armId: string;
  readonly replicate: number;
  readonly taskDigest: string;
  readonly dispatch: number;
}

/**
 * Expected cells with no non-replaceable terminal `cell-event` and no completed evaluation —
 * the crash-safe resume set. A cell the fold never heard of (never dispatched) is outstanding
 * at `dispatch: 1`; a cell whose last terminal is replaceable (§7.4: `expired` only, in this
 * driver — `unscorable`/`exclusion-hit` require host facts this driver never supplies) is
 * outstanding at `dispatch: lastDispatch + 1`, mirroring `launchAndWatch`'s own replacement
 * numbering. A cell already delivered (a non-replaceable terminal) is never solve-outstanding
 * even if its evaluation leg is still missing — that gap is handled separately by re-running
 * only the evaluation leg for delivered-but-unevaluated cells (see `./drive.ts`).
 */
export function outstandingCells(
  expected: readonly ExpectedCellCoord[],
  fold: ReadonlyMap<string, CellJournalFold>,
): OutstandingCell[] {
  return expected
    .filter((coord) => {
      const cell = fold.get(coord.cellKey);
      if (cell === undefined) return true;
      const nonReplaceableTerminal =
        (cell.status === "delivered" || cell.status === "judged"
          || cell.status === "cancelled" || cell.status === "failed");
      const completedEvaluation = cell.verdicts.length > 0 || cell.evaluationTerminal !== undefined;
      return !nonReplaceableTerminal && !completedEvaluation;
    })
    .map((coord) => {
      const cell = fold.get(coord.cellKey);
      // A replaceable terminal (expired) needs a FRESH dispatch number — resubmitting at the
      // same number would find the expired attempt's own cached Submission bytes via
      // `acceptedSubmissions` and idempotently re-observe the same expired result forever.
      // An in-flight or never-terminal cell resumes AT its last (or first) dispatch number so
      // the accepted-submission lookup reunites with the same Submission instead of minting a
      // second one for work already underway.
      const dispatch = cell === undefined
        ? 1
        : cell.status === "expired"
          ? cell.lastDispatch + 1
          : Math.max(cell.lastDispatch, 1);
      return {
        cellKey: coord.cellKey,
        armId: coord.armId,
        replicate: coord.replicate,
        taskDigest: coord.taskDigest,
        dispatch,
      };
    });
}

/**
 * Delivered cells (status "delivered" or "judged") whose completed evaluation legs do not cover
 * every index in `1..minVerdicts` — the evaluation-only resume gap, per leg (BP-21). "judged"
 * qualifies because the very first verdict flips the fold's status while later legs may still be
 * missing. `missingEvalIndexes` lists the uncovered indexes in ascending order.
 */
export function evaluationGaps(
  fold: ReadonlyMap<string, CellJournalFold>,
  minVerdicts: number,
): { cell: CellJournalFold; missingEvalIndexes: number[] }[] {
  const gaps: { cell: CellJournalFold; missingEvalIndexes: number[] }[] = [];
  for (const cell of fold.values()) {
    if (cell.status !== "delivered" && cell.status !== "judged") continue;
    const completed = new Set(cell.completedEvalIndexes);
    const missingEvalIndexes: number[] = [];
    for (let evalIndex = 1; evalIndex <= minVerdicts; evalIndex += 1) {
      if (!completed.has(evalIndex)) missingEvalIndexes.push(evalIndex);
    }
    if (missingEvalIndexes.length > 0) gaps.push({ cell, missingEvalIndexes });
  }
  return gaps;
}
