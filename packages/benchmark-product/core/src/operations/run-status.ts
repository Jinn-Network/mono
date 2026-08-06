/**
 * `run.status` (spec §4.6 Official run row: "per-cell live status (dispatched/claimed/
 * delivered/judged)"): a read-only fold of the run journal over the Run record's expected cell
 * set. Ungated — a read, like every other inspection operation.
 *
 * Requires the draft to have been locked at least once (a sealed Run record and its expected
 * cell set are the only source of "what cells exist"); available from `locked` on, including
 * `running` and every state after it, since the journal and the sealed Run record it reports on
 * never change shape once written.
 */

import {
  expectedCellSet,
  parseBenchmark,
  parseRun,
} from "@jinn-network/benchmarking-records";
import type { LifecycleState } from "../domain/lifecycle.js";
import { refuse } from "../errors.js";
import { foldRunJournal, readRunJournalEntries, type CellStatus } from "../run/journal.js";
import { requireRunState } from "../run/state.js";
import { getSealedBytes } from "../workspace/sealed-store.js";
import type { OperationContext } from "./context.js";
import { readDraftDocument } from "./drafts.js";
import { operate } from "./operate.js";
import type { OperationResult } from "./result.js";

export interface RunStatusCell {
  readonly cellKey: string;
  readonly armId: string;
  readonly replicate: number;
  readonly taskSha256: string;
  readonly status: CellStatus;
  readonly dispatches: number;
  readonly attempt?: string;
  readonly deliverySha256?: string;
  readonly verdictSha256?: string;
  readonly detail?: string;
}

export interface RunStatusCounts {
  readonly expected: number;
  /** Cells with at least one dispatch, regardless of current status. */
  readonly dispatched: number;
  /** Cells that reached a solve delivery (status "delivered" or "judged" — judged implies delivered). */
  readonly delivered: number;
  readonly judged: number;
  /** Cells whose accounted terminal is a non-replaceable failure (excludes "expired"/"cancelled",
   * each visible on the per-cell `status` for callers who want that distinction). */
  readonly failed: number;
}

export interface RunStatusResult {
  readonly state: LifecycleState;
  readonly closeAt?: string;
  readonly cells: readonly RunStatusCell[];
  readonly counts: RunStatusCounts;
}

export function runStatus(
  context: OperationContext,
  input: { readonly draftId: string },
): OperationResult<RunStatusResult> {
  return operate({
    context,
    action: "run.status",
    subject: input.draftId,
    inputs: input,
    run: () => {
      const document = readDraftDocument(context.workspaceDir, input.draftId);
      const runState = requireRunState(context.workspaceDir, input.draftId);
      if (runState.runSha256 === undefined) {
        refuse(
          "conflict",
          `runs.${input.draftId}`,
          `draft ${input.draftId} has not been locked yet — no Run record to report status for`,
        );
      }
      if (document.spec.taskSet.kind !== "benchmark") {
        refuse("conflict", `drafts.${input.draftId}.taskSet`, `draft ${input.draftId} has no attached benchmark`);
      }

      const runRecord = parseRun(getSealedBytes(context.workspaceDir, runState.runSha256));
      const benchRecord = parseBenchmark(getSealedBytes(context.workspaceDir, document.spec.taskSet.benchmarkSha256));
      const expected = expectedCellSet(benchRecord, runRecord);
      const fold = foldRunJournal(readRunJournalEntries(context.workspaceDir, input.draftId));

      const cells: RunStatusCell[] = expected.map((coord) => {
        const cell = fold.get(coord.cellKey);
        return {
          cellKey: coord.cellKey,
          armId: coord.armId,
          replicate: coord.replicate,
          taskSha256: coord.taskDigest,
          status: cell?.status ?? "pending",
          dispatches: cell?.dispatches ?? 0,
          ...(cell?.attempt !== undefined ? { attempt: cell.attempt } : {}),
          ...(cell?.deliverySha256 !== undefined ? { deliverySha256: cell.deliverySha256 } : {}),
          ...(cell?.verdictSha256 !== undefined ? { verdictSha256: cell.verdictSha256 } : {}),
          ...(cell?.detail !== undefined ? { detail: cell.detail } : {}),
        };
      });

      const counts: RunStatusCounts = {
        expected: cells.length,
        dispatched: cells.filter((cell) => cell.dispatches > 0).length,
        delivered: cells.filter((cell) => cell.status === "delivered" || cell.status === "judged").length,
        judged: cells.filter((cell) => cell.status === "judged").length,
        failed: cells.filter((cell) => cell.status === "failed").length,
      };

      return {
        state: document.state,
        ...(runState.closeAt !== undefined ? { closeAt: runState.closeAt } : {}),
        cells,
        counts,
      };
    },
  });
}
