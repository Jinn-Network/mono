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
import { BEACON_SOURCE_IDS, requiredBeaconRound, runBindingClass, runBindingSentence } from "@colophon-claims/verify";
import type { BeaconSourceId, RunBindingClass, VerifiedRunBinding } from "@colophon-claims/verify";
import { readRunBindingCarriage } from "../binding/carriage.js";
import type { LifecycleState } from "../domain/lifecycle.js";
import { refuse, type ProductErrorEnvelope } from "../errors.js";
import { cancelRequested } from "../run/cancel-marker.js";
import { evaluationGaps, foldRunJournal, readRunJournalEntries, type CellStatus } from "../run/journal.js";
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
  /** Task-vs-infrastructure attribution for this cell's most recent "error" terminal (BP-22),
   * folded from the run journal's own `blame` field (`../run/journal.ts`). Absent whenever no
   * error terminal on the current dispatch carried an observable blame. */
  readonly blame?: "task" | "infrastructure";
  readonly evaluationRecovery?: {
    readonly retryableFailures: number;
    readonly pending: boolean;
    readonly recovered: boolean;
    readonly exhausted: boolean;
  };
  /** Present, while the run is `running`, whenever this cell is in the UNFILTERED
   * evaluation-gap set (`../run/journal.ts`'s `evaluationGaps`) — the same set `run.resume`
   * sweeps when it is allowed to run at all (`./run-launch.ts`; a pending cancel marker makes
   * it sweep nothing) and `run.collect` reads for terminal accounting
   * (`./run-collect.ts`). This is a state, not a call to action: a delivered cell an active
   * driver is still judging is in this set too. Deliberately independent of
   * `evaluationRecovery`, which reports only infrastructure-retry recovery and disappears
   * entirely when the run's policy allows no retries: a gap can exist with nothing having
   * failed at all (issue #3084). `deliveryJournaled: false` is exactly the issue #3081 shape —
   * a `delivered` cell-event whose `delivery` record never made it to the journal, which
   * `run.resume` heals from the attempt the cell-event named. */
  readonly evaluationGap?: {
    readonly missingEvalIndexes: readonly number[];
    readonly deliveryJournaled: boolean;
  };
}

export interface RunStatusCounts {
  readonly expected: number;
  /** Cells with at least one dispatch, regardless of current status. */
  readonly dispatched: number;
  /** Cells that reached a solve delivery (status "delivered" or "judged" — judged implies delivered). */
  readonly delivered: number;
  readonly judged: number;
  /** Cells carrying an `evaluationGap` — delivered, but with no journaled verdict yet. Zero
   * outside `running`, where `resume` cannot act. Non-zero becomes a cue to resume only once
   * no driver is active and no cancellation is pending; while a driver is working, this is
   * ordinary in-flight progress. */
  readonly awaitingEvaluation: number;
  /** Cells whose accounted terminal is a non-replaceable failure (excludes "expired"/"cancelled",
   * each visible on the per-cell `status` for callers who want that distinction). */
  readonly failed: number;
}

export interface RunDriverStatus {
  readonly operation: "launch" | "resume";
  readonly generation: string;
  readonly startedAt: string;
  readonly status: "active" | "failed" | "succeeded";
  readonly completedAt?: string;
  readonly error?: ProductErrorEnvelope;
}

export interface RunStatusResult {
  readonly state: LifecycleState;
  readonly closeAt?: string;
  /** True once a cancellation has been requested (BP-22, `../run/cancel-marker.ts`'s
   * `cancelRequested`) — a present, schema-valid marker, independent of whether `run.cancel` has
   * yet finalized it (spec §4.6 Official-run row: the state line shows "cancel requested"). */
  readonly cancelRequested: boolean;
  /** Latest durable driver generation. `active` after a restart is intentionally distinct from
   * an in-memory promise: it means the journal has no terminal outcome and `resume` may recover. */
  readonly driver?: RunDriverStatus;
  readonly cells: readonly RunStatusCell[];
  readonly counts: RunStatusCounts;
  /**
   * The run's `beacon-binding/1` binding (issue #2976), recomputed from the sealed record on every
   * read rather than reported from state. Absent on a run that has never bound; `statement` is the
   * report face's own words for which binding applied, so an operator reading status sees the same
   * sentence a reader of the run does.
   */
  readonly binding?: {
    readonly class: RunBindingClass;
    readonly beacon: VerifiedRunBinding["beacon"];
    readonly postSeal: VerifiedRunBinding["postSeal"];
    readonly poolDigest: string;
    readonly statement: string;
  };
  /**
   * The rounds this run may still bind to, one per admitted source whose rounds follow a published
   * schedule (issue #3322). `bind` refuses every other round on those sources, so the number is not
   * something an operator can be left to guess: it is derived from this run's own seal, and it is
   * what they fetch the value for. Absent once the run has bound, once it has launched, and before
   * it is locked — in each of those cases there is no round left to offer.
   */
  readonly bindableBeaconRounds?: readonly {
    readonly source: BeaconSourceId;
    readonly round: number;
    /** RFC 3339 UTC instant that round publishes, from the source's own schedule. */
    readonly publishedAt: string;
  }[];
  readonly evaluationRecovery?: {
    readonly maxInfrastructureRetries: 1;
    readonly retryableFailures: number;
    readonly pendingCells: number;
    readonly recoveredCells: number;
    readonly exhaustedCells: number;
  };
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
      const entries = readRunJournalEntries(context.workspaceDir, input.draftId);
      const fold = foldRunJournal(entries);
      const maxInfrastructureRetries = runRecord.policy.evaluation?.maxInfrastructureRetries ?? 0;
      const gaps = evaluationGaps(
        fold,
        runRecord.policy.evaluation?.minVerdicts ?? 1,
        maxInfrastructureRetries,
      );
      // Gated on `running` for the same reason `pendingEvaluationCells` below is: `run.resume`
      // refuses outside `running` (`./run-launch.ts`'s `loadLockedOrRunningRun`), so reporting a
      // gap on a closed run would be a permanent cue to an operation that cannot act on it.
      const gapsByCellKey = document.state === "running"
        ? new Map(gaps.map((gap) => [gap.cell.cellKey, gap]))
        : new Map<string, typeof gaps[number]>();
      const pendingEvaluationCells = new Set(
        gaps.filter((gap) => document.state === "running"
          && gap.cell.evaluationLegs.some((leg) => leg.retryableFailures > 0))
          .map((gap) => gap.cell.cellKey),
      );

      const driverGenerations = new Map<string, RunDriverStatus & { readonly eventIndex: number }>();
      entries.forEach((entry, eventIndex) => {
        if (entry.kind === "driver-started") {
          if (driverGenerations.has(entry.generation)) {
            refuse(
              "journal-integrity",
              `runs.${input.draftId}.${eventIndex}`,
              `driver generation ${entry.generation} starts more than once`,
            );
          }
          driverGenerations.set(entry.generation, {
            operation: entry.operation,
            generation: entry.generation,
            startedAt: entry.at,
            status: "active",
            eventIndex,
          });
        } else if (
          (entry.kind === "driver-failed" || entry.kind === "driver-succeeded")
        ) {
          const started = driverGenerations.get(entry.generation);
          if (started === undefined || started.operation !== entry.operation || started.status !== "active") {
            refuse(
              "journal-integrity",
              `runs.${input.draftId}.${eventIndex}`,
              `driver terminal ${entry.generation} has no matching active generation`,
            );
          }
          driverGenerations.set(entry.generation, {
            ...started,
            status: entry.kind === "driver-failed" ? "failed" : "succeeded",
            completedAt: entry.at,
            ...(entry.kind === "driver-failed" ? { error: entry.error } : {}),
            eventIndex,
          });
        }
      });
      const generations = [...driverGenerations.values()];
      // Only venue owners are journaled by runLaunch/runResume, so simple journal order is the
      // causal order: a later sequential failure must supersede an earlier success.
      const selectedDriver = generations.sort((left, right) => right.eventIndex - left.eventIndex)[0];
      const driver: RunDriverStatus | undefined = selectedDriver === undefined
        ? undefined
        : {
            operation: selectedDriver.operation,
            generation: selectedDriver.generation,
            startedAt: selectedDriver.startedAt,
            status: selectedDriver.status,
            ...(selectedDriver.completedAt !== undefined ? { completedAt: selectedDriver.completedAt } : {}),
            ...(selectedDriver.error !== undefined ? { error: selectedDriver.error } : {}),
          };

      const cells: RunStatusCell[] = expected.map((coord) => {
        const cell = fold.get(coord.cellKey);
        const gap = gapsByCellKey.get(coord.cellKey);
        const retryableFailures = cell?.evaluationLegs.reduce(
          (total, leg) => total + leg.retryableFailures,
          0,
        ) ?? 0;
        const recovered = cell?.evaluationLegs.some((leg) => leg.retryableFailures > 0
          && cell.verdicts.some((verdict) => (verdict.evalIndex ?? 1) === leg.evalIndex)) ?? false;
        const exhausted = cell?.evaluationLegs.some((leg) => leg.retryableFailures > 0
          && (cell.completedEvalIndexes.includes(leg.evalIndex) || document.state === "closed")
          && !cell.verdicts.some((verdict) => (verdict.evalIndex ?? 1) === leg.evalIndex)) ?? false;
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
          ...(cell?.blame !== undefined ? { blame: cell.blame } : {}),
          ...(gap === undefined ? {} : {
            evaluationGap: {
              missingEvalIndexes: gap.missingEvalIndexes,
              deliveryJournaled: gap.cell.deliverySha256 !== undefined,
            },
          }),
          ...(maxInfrastructureRetries === 0 ? {} : {
            evaluationRecovery: {
              retryableFailures,
              pending: pendingEvaluationCells.has(coord.cellKey),
              recovered,
              exhausted,
            },
          }),
        };
      });

      const counts: RunStatusCounts = {
        expected: cells.length,
        dispatched: cells.filter((cell) => cell.dispatches > 0).length,
        delivered: cells.filter((cell) => cell.status === "delivered" || cell.status === "judged").length,
        judged: cells.filter((cell) => cell.status === "judged").length,
        awaitingEvaluation: cells.filter((cell) => cell.evaluationGap !== undefined).length,
        failed: cells.filter((cell) => cell.status === "failed").length,
      };

      const binding = readRunBindingCarriage(context.workspaceDir, runState);
      const bindable = binding === undefined
        && document.state === "locked"
        && runState.launchedAt === undefined
        && runState.lockedAt !== undefined
        ? BEACON_SOURCE_IDS.flatMap((source) => {
          const required = requiredBeaconRound(source, runState.lockedAt!);
          return required === undefined ? [] : [{ source, round: required.round, publishedAt: required.publishedAt }];
        })
        : [];

      return {
        state: document.state,
        ...(runState.closeAt !== undefined ? { closeAt: runState.closeAt } : {}),
        ...(binding === undefined ? {} : {
          binding: {
            class: runBindingClass(binding),
            beacon: binding.beacon,
            postSeal: binding.postSeal,
            poolDigest: binding.poolDigest,
            statement: runBindingSentence(binding),
          },
        }),
        ...(bindable.length === 0 ? {} : { bindableBeaconRounds: bindable }),
        cancelRequested: cancelRequested(context.workspaceDir, input.draftId),
        ...(driver !== undefined ? { driver } : {}),
        cells,
        counts,
        ...(maxInfrastructureRetries === 0 ? {} : {
          evaluationRecovery: {
            maxInfrastructureRetries: 1 as const,
            retryableFailures: cells.reduce(
              (total, cell) => total + (cell.evaluationRecovery?.retryableFailures ?? 0),
              0,
            ),
            pendingCells: cells.filter((cell) => cell.evaluationRecovery?.pending).length,
            recoveredCells: cells.filter((cell) => cell.evaluationRecovery?.recovered).length,
            exhaustedCells: cells.filter((cell) => cell.evaluationRecovery?.exhausted).length,
          },
        }),
      };
    },
  });
}
