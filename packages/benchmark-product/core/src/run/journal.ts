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
 * Eleven entry kinds (driver start/terminals included):
 * - `launched` — the run driver started (one per `runLaunch` call).
 * - `cell-event` — a solve-side `CellStatusEvent` from `launchAndWatch`/`resumeRun`, verbatim.
 *   Optionally carries `blame` (BP-22): for an "error" terminal, the platform-derived
 *   task-vs-infrastructure attribution `../run/drive.ts` best-effort observed at journal-write
 *   time (`"task" | "infrastructure"`, absent when unobservable — never a reason to fail the
 *   write it enriches).
 * - `submission-accepted` — the exact sealed Submission bytes were stored, keyed by dispatch.
 * - `delivery` — the exact sealed Delivery bytes were stored for a dispatch's accounted attempt.
 * - `evaluation` — the evaluation leg reached a terminal (a verdict, or a could-not-grade fact).
 * - `evaluation-retryable-failure` — one typed provider/transport outage left the exact
 *   evaluation leg open without changing solve dispatch or patch identity.
 * - `cancel-requested` (BP-22) — `run.cancel` recorded a cancellation request. Written exactly
 *   once per run, alongside (never instead of) the durable cancel marker
 *   (`./cancel-marker.ts`) — the marker is the fact other operations gate on; this entry is the
 *   audit-trail echo of it inside the same journal every other cell activity lives in.
 * - `closed` — `run.collect` OR `run.cancel` sealed the Matrix.
 */

import { z } from "zod";
import { TASK_EXECUTION_ERROR_CATEGORIES } from "@jinn-network/task-execution-protocol";
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
    evalIndex: z.number().int().positive().optional(),
    evaluationAttempt: z.number().int().positive().optional(),
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
    evaluationAttempt: z.number().int().positive().optional(),
    failureCategory: z.enum(TASK_EXECUTION_ERROR_CATEGORIES).optional(),
  }),
  z.object({
    kind: z.literal("evaluation-retryable-failure"),
    at: Rfc3339Schema,
    cellKey: z.string(),
    dispatch: z.number().int().positive(),
    evalIndex: z.number().int().positive(),
    evaluationAttempt: z.number().int().positive(),
    evaluator: z.string(),
    evalTaskSha256: Sha256HexSchema.optional(),
    evalAttempt: z.string().optional(),
    category: z.enum(["backend-unavailable", "dependency-unavailable", "transport-failure"]),
    recoveryAdvice: z.literal("new-attempt-required"),
    detail: z.string(),
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
  readonly evaluationLegs: readonly {
    readonly evalIndex: number;
    readonly attempts: number;
    readonly retryableFailures: number;
    readonly lastFailureCategory?: typeof TASK_EXECUTION_ERROR_CATEGORIES[number];
  }[];
  readonly detail?: string;
  /** The most recent task-vs-infrastructure attribution journaled for this cell's CURRENT
   * dispatch (BP-22) — set from a cell-event entry's `blame`, reset (to absent) on a fresh
   * dispatch alongside the other per-dispatch fields. Absent whenever no "error" terminal on
   * this dispatch carried an observable blame. */
  readonly blame?: "task" | "infrastructure";
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
  evaluationLegs: Map<number, {
    attempts: number;
    retryableFailures: number;
    lastFailureCategory?: typeof TASK_EXECUTION_ERROR_CATEGORIES[number];
  }>;
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
      evaluationLegs: new Map(),
    };
    byCell.set(cellKey, fresh);
    return fresh;
  };

  for (const entry of entries) {
    if (entry.kind === "cell-event") {
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
        fold.evaluationLegs = new Map();
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
        fold.pinningEvidenceSha256 = entry.pinningEvidenceSha256;
      } else if (entry.evalIndex !== undefined) {
        const leg = fold.evaluationLegs.get(entry.evalIndex) ?? { attempts: 0, retryableFailures: 0 };
        const evaluationAttempt = entry.evaluationAttempt ?? 1;
        if (evaluationAttempt !== leg.retryableFailures + 1) {
          refuse("journal-integrity", entry.cellKey, "evaluation Submission attempt is outside its contiguous retry lineage");
        }
        leg.attempts = Math.max(leg.attempts, evaluationAttempt);
        fold.evaluationLegs.set(entry.evalIndex, leg);
      }
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
      const evalIndex = entry.evalIndex ?? 1;
      const leg = fold.evaluationLegs.get(evalIndex) ?? { attempts: 0, retryableFailures: 0 };
      const evaluationAttempt = entry.evaluationAttempt ?? 1;
      if (fold.completedEvalIndexes.has(evalIndex) || evaluationAttempt !== leg.retryableFailures + 1) {
        refuse("journal-integrity", entry.cellKey, "evaluation terminal is duplicate or outside its contiguous retry lineage");
      }
      fold.completedEvalIndexes.add(evalIndex);
      leg.attempts = Math.max(leg.attempts, evaluationAttempt);
      if (entry.failureCategory !== undefined) leg.lastFailureCategory = entry.failureCategory;
      fold.evaluationLegs.set(evalIndex, leg);
      if (entry.detail !== undefined) fold.detail = entry.detail;
    } else if (entry.kind === "evaluation-retryable-failure") {
      const fold = ensure(entry.cellKey, "", 0);
      const leg = fold.evaluationLegs.get(entry.evalIndex) ?? { attempts: 0, retryableFailures: 0 };
      if (fold.completedEvalIndexes.has(entry.evalIndex)
        || entry.evaluationAttempt !== leg.retryableFailures + 1) {
        refuse("journal-integrity", entry.cellKey, "evaluation retry failure is duplicate or non-contiguous");
      }
      leg.attempts = Math.max(leg.attempts, entry.evaluationAttempt);
      leg.retryableFailures += 1;
      leg.lastFailureCategory = entry.category;
      fold.evaluationLegs.set(entry.evalIndex, leg);
      fold.detail = entry.detail;
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
      evaluationLegs: [...fold.evaluationLegs.entries()]
        .sort(([left], [right]) => left - right)
        .map(([evalIndex, leg]) => ({ evalIndex, ...leg })),
      ...(fold.detail !== undefined ? { detail: fold.detail } : {}),
      ...(fold.blame !== undefined ? { blame: fold.blame } : {}),
    });
  }
  return result;
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
  maxInfrastructureRetries = 0,
): { cell: CellJournalFold; missingEvalIndexes: number[]; nextEvaluationAttempts: Readonly<Record<number, number>> }[] {
  const gaps: { cell: CellJournalFold; missingEvalIndexes: number[]; nextEvaluationAttempts: Readonly<Record<number, number>> }[] = [];
  for (const cell of fold.values()) {
    if (cell.status !== "delivered" && cell.status !== "judged") continue;
    const completed = new Set(cell.completedEvalIndexes);
    const missingEvalIndexes: number[] = [];
    const nextEvaluationAttempts: Record<number, number> = {};
    for (let evalIndex = 1; evalIndex <= minVerdicts; evalIndex += 1) {
      if (completed.has(evalIndex)) continue;
      const leg = cell.evaluationLegs.find((candidate) => candidate.evalIndex === evalIndex);
      const retryableFailures = leg?.retryableFailures ?? 0;
      if (retryableFailures > maxInfrastructureRetries) continue;
      missingEvalIndexes.push(evalIndex);
      // An accepted evaluation Submission with no terminal is resumed under the SAME attempt
      // identity. Only a durable retryable failure advances the attempt number.
      nextEvaluationAttempts[evalIndex] = retryableFailures + 1;
    }
    if (missingEvalIndexes.length > 0) gaps.push({ cell, missingEvalIndexes, nextEvaluationAttempts });
  }
  return gaps;
}
