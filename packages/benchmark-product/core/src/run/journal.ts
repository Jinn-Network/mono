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
 * Six entry kinds:
 * - `launched` — the run driver started (one per `runLaunch` call).
 * - `cell-event` — a solve-side `CellStatusEvent` from `launchAndWatch`/`resumeRun`, verbatim.
 * - `submission-accepted` — the exact sealed Submission bytes were stored, keyed by dispatch.
 * - `delivery` — the exact sealed Delivery bytes were stored for a dispatch's accounted attempt.
 * - `evaluation` — the evaluation leg reached a terminal (a verdict, or a could-not-grade fact).
 * - `closed` — `run.collect` sealed the Matrix.
 */

import { z } from "zod";
import { refuse, refuseWithIssues, type ProductIssue } from "../errors.js";
import { appendFsyncedLineSync, readTextIfExistsSync } from "../fs/atomic.js";
import { runJournalPath } from "../workspace/layout.js";

const Rfc3339Schema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
  "must be an RFC 3339 timestamp",
);

const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/, "must be a lowercase sha256 hex digest");

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
  z.object({ kind: z.literal("cell-event"), at: Rfc3339Schema, event: CellStatusEventSchema }),
  z.object({
    kind: z.literal("submission-accepted"),
    at: Rfc3339Schema,
    cellKey: z.string(),
    dispatch: z.number().int().positive(),
    submissionSha256: Sha256HexSchema,
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
    evalAttempt: z.string().optional(),
    verdictSha256: Sha256HexSchema.optional(),
    evaluationTerminal: z.literal("could-not-grade").optional(),
    detail: z.string().optional(),
  }),
  z.object({ kind: z.literal("closed"), at: Rfc3339Schema, matrixSha256: Sha256HexSchema }),
]);

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
  readonly deliverySha256?: string;
  readonly deliveryOutputs?: readonly { readonly name: string; readonly sha256: string }[];
  readonly verdictSha256?: string;
  readonly evaluationTerminal?: "could-not-grade";
  readonly detail?: string;
}

interface MutableFold {
  cellKey: string;
  armId: string;
  replicate: number;
  dispatches: number;
  lastDispatch: number;
  attempt?: string;
  lastKind?: CellStatusEventLike["kind"];
  replaceableReason?: CellStatusEventLike["replaceableReason"];
  detail?: string;
  submissionSha256?: string;
  deliverySha256?: string;
  deliveryOutputs?: { name: string; sha256: string }[];
  verdictSha256?: string;
  evaluationTerminal?: "could-not-grade";
}

function statusFor(fold: MutableFold): CellStatus {
  if (fold.verdictSha256 !== undefined) return "judged";
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
    const fresh: MutableFold = { cellKey, armId, replicate, dispatches: 0, lastDispatch: 0 };
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
        fold.dispatches += 1;
        // A fresh dispatch starts over: any prior terminal accounting described the earlier attempt.
        fold.replaceableReason = undefined;
        fold.detail = undefined;
        fold.deliverySha256 = undefined;
        fold.deliveryOutputs = undefined;
        fold.verdictSha256 = undefined;
        fold.evaluationTerminal = undefined;
      } else {
        fold.replaceableReason = event.replaceableReason;
        if (event.detail !== undefined) fold.detail = event.detail;
      }
    } else if (entry.kind === "submission-accepted") {
      const fold = ensure(entry.cellKey, "", 0);
      if (entry.dispatch > fold.lastDispatch) fold.lastDispatch = entry.dispatch;
      fold.submissionSha256 = entry.submissionSha256;
    } else if (entry.kind === "delivery") {
      const fold = ensure(entry.cellKey, "", 0);
      fold.deliverySha256 = entry.deliverySha256;
      fold.deliveryOutputs = entry.outputs;
      if (entry.attempt !== undefined) fold.attempt = entry.attempt;
    } else if (entry.kind === "evaluation") {
      const fold = ensure(entry.cellKey, "", 0);
      if (entry.verdictSha256 !== undefined) fold.verdictSha256 = entry.verdictSha256;
      if (entry.evaluationTerminal !== undefined) fold.evaluationTerminal = entry.evaluationTerminal;
      if (entry.detail !== undefined) fold.detail = entry.detail;
    }
    // "launched" and "closed" carry no per-cell accounting.
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
      ...(fold.deliverySha256 !== undefined ? { deliverySha256: fold.deliverySha256 } : {}),
      ...(fold.deliveryOutputs !== undefined ? { deliveryOutputs: fold.deliveryOutputs } : {}),
      ...(fold.verdictSha256 !== undefined ? { verdictSha256: fold.verdictSha256 } : {}),
      ...(fold.evaluationTerminal !== undefined ? { evaluationTerminal: fold.evaluationTerminal } : {}),
      ...(fold.detail !== undefined ? { detail: fold.detail } : {}),
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
      const completedEvaluation = cell.verdictSha256 !== undefined || cell.evaluationTerminal !== undefined;
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

/** Delivered cells with no evaluation entry yet — the evaluation-only resume gap. */
export function deliveredWithoutEvaluation(
  fold: ReadonlyMap<string, CellJournalFold>,
): CellJournalFold[] {
  return [...fold.values()].filter(
    (cell) => cell.status === "delivered" && cell.verdictSha256 === undefined && cell.evaluationTerminal === undefined,
  );
}
