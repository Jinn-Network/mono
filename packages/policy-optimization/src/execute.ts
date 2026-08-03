// SPDX-License-Identifier: MIT

/**
 * Wave execution and Matrix assembly (product design §6.1).
 *
 * > cells dispatched through the injected backend, Matrix assembled and verified
 *
 * Both halves are composition and nothing else: `launchAndWatch` dispatches, `assembleMatrix`
 * assembles, and `localAssemblyPorts` supplies the local venue's port bundle. What this file adds
 * is the join between them — the dispatch loop yields a stream of status events, assembly wants a
 * set of in-scope cells, and turning one into the other is a bookkeeping job neither package will
 * do for the other.
 *
 * The join is deliberately **total over the expected cell set**, not over the events. A cell the
 * loop never reached (close boundary hit, owner cancelled, backend refused) still exists, still
 * belongs in the Matrix, and still has to report `dispatches: 0` rather than vanishing. A join
 * driven off the event stream would silently shrink the denominator of every rate computed
 * downstream.
 */

import { assembleMatrix, launchAndWatch, type AssembledMatrix, type InScopeCell, type LaunchOptions } from "@jinn-network/benchmarking-run";
import { localAssemblyPorts } from "@jinn-network/benchmarking-local";
import { compareCodeUnitStrings, expectedCellSet } from "@jinn-network/benchmarking-records";
import type { TaskExecutionBackend } from "@jinn-network/task-execution-backend";
import { refuse } from "./errors.js";
import type {
  CellStatusEvent,
  WaveAssemblyVenue,
  WaveCellEvidence,
  WaveCellEvidencePort,
  WaveDispatch,
  WaveExecution,
  WavePlan,
} from "./wave-types.js";

/** Options the host owns; `runDigest` and the Task resolver are the plan's and the venue's. */
export type WaveLaunchOptions = Omit<LaunchOptions, "runDigest" | "taskBytesFor">;

export interface ExecuteWaveInput {
  readonly plan: WavePlan;
  readonly backend: TaskExecutionBackend;
  /**
   * Exact sealed Task bytes for a benchmark item's digest (bare lowercase hex).
   *
   * For a promotion Run these are the **revealed** bytes: a committed Benchmark's items carry
   * their digests in the open and their content held back, so a promotion Run is simply not
   * dispatchable until reveal — the discipline is enforced by arithmetic here, not only by policy.
   */
  readonly taskBytesFor: (taskDigestHex: string) => Uint8Array | Promise<Uint8Array>;
  readonly launch?: WaveLaunchOptions;
}

function terminalKindOf(events: readonly CellStatusEvent[]): CellStatusEvent | undefined {
  return [...events].reverse().find((event) => event.kind !== "dispatch" && event.kind !== "claimed");
}

/**
 * Dispatches every expected cell of a sealed wave and folds the status stream into a per-cell
 * account.
 *
 * `dispatches` counts distinct dispatch events for the cell — §7.4 replacements included, because
 * that is what the Matrix's attrition block means by the word.
 */
export async function executeWave(input: ExecuteWaveInput): Promise<WaveExecution> {
  const { plan } = input;
  const events: CellStatusEvent[] = [];
  for await (const event of launchAndWatch(plan.benchmark.record, plan.run.record, input.backend, {
    ...(input.launch ?? {}),
    runDigest: plan.run.digest,
    taskBytesFor: input.taskBytesFor,
  })) {
    events.push(event);
  }

  const byCell = new Map<string, CellStatusEvent[]>();
  let cancelled = false;
  for (const event of events) {
    if (event.cancelledRun === true) cancelled = true;
    if (event.cellKey === "drain" || event.cellKey === "*") continue;
    const bucket = byCell.get(event.cellKey) ?? [];
    bucket.push(event);
    byCell.set(event.cellKey, bucket);
  }

  const dispatches: WaveDispatch[] = expectedCellSet(plan.benchmark.record, plan.run.record)
    .map((coord) => {
      const cellEvents = byCell.get(coord.cellKey) ?? [];
      const dispatchEvents = cellEvents.filter((event) => event.kind === "dispatch");
      const terminal = terminalKindOf(cellEvents);
      const accounted = dispatchEvents.at(-1);
      return {
        cellKey: coord.cellKey,
        armId: coord.armId,
        replicate: coord.replicate,
        taskDigest: coord.taskDigest,
        dispatches: dispatchEvents.length,
        ...(dispatchEvents.length > 0 ? { accounted: dispatchEvents.length } : {}),
        ...(accounted?.attempt === undefined ? {} : { attempt: accounted.attempt }),
        ...(accounted?.submissionDigest === undefined
          ? {}
          : { submissionDigest: accounted.submissionDigest }),
        ...(terminal === undefined ? {} : { terminal: terminal.kind }),
        ...(terminal?.detail === undefined ? {} : { detail: terminal.detail }),
      } satisfies WaveDispatch;
    })
    .sort((left, right) => compareCodeUnitStrings(left.cellKey, right.cellKey));

  return { runDigest: plan.run.digest, events, dispatches, cancelled };
}

export interface AssembleWaveInput {
  readonly plan: WavePlan;
  readonly execution: WaveExecution;
  readonly evidence: WaveCellEvidencePort;
  readonly venue: WaveAssemblyVenue;
}

function inScopeCell(dispatch: WaveDispatch, evidence: WaveCellEvidence | undefined): InScopeCell {
  return {
    cellKey: dispatch.cellKey,
    armId: dispatch.armId,
    replicate: dispatch.replicate,
    taskDigest: dispatch.taskDigest,
    dispatches: dispatch.dispatches,
    ...(dispatch.accounted === undefined ? {} : { accounted: dispatch.accounted }),
    ...(dispatch.submissionDigest === undefined ? {} : { submissionDigest: dispatch.submissionDigest }),
    ...(dispatch.attempt === undefined ? {} : { attempt: dispatch.attempt }),
    ...(evidence?.deliveryBytes === undefined ? {} : { deliveryBytes: evidence.deliveryBytes }),
    ...(evidence?.deliveryDigest === undefined ? {} : { deliveryDigest: evidence.deliveryDigest }),
    ...(evidence?.evaluationSpec === undefined ? {} : { evaluationSpec: evidence.evaluationSpec }),
    ...(evidence?.evaluationSpecDigest === undefined
      ? {}
      : { evaluationSpecDigest: evidence.evaluationSpecDigest }),
    ...(evidence?.evaluationTerminal === undefined
      ? {}
      : { evaluationTerminal: evidence.evaluationTerminal }),
    verdicts: evidence?.verdicts ?? [],
  };
}

/**
 * Assembles the wave's Matrix over the local venue's ports.
 *
 * `isolationInventory` is threaded through because `benchmarking-local` requires it and refuses a
 * default: a host that has not said what its launchers can produce must not collect a vacuous
 * `match` on the isolation axis by omission. Nothing here relaxes that — the product asks its
 * caller for the same fact, in the same required position.
 */
export async function assembleWaveMatrix(input: AssembleWaveInput): Promise<AssembledMatrix> {
  const { plan, execution } = input;
  if (execution.runDigest !== plan.run.digest) {
    refuse("wave-composition", "execution.runDigest",
      `the execution ran ${execution.runDigest}; this plan sealed ${plan.run.digest}`);
  }
  if (input.venue.isolationInventory.length === 0) {
    refuse("wave-composition", "venue.isolationInventory",
      "a venue that declares no isolation inventory has said nothing about what it could have run");
  }

  const evidenceByCell = new Map<string, WaveCellEvidence | undefined>();
  for (const dispatch of execution.dispatches) {
    evidenceByCell.set(dispatch.cellKey, await input.evidence.evidenceFor(dispatch.cellKey));
  }
  const cells = execution.dispatches.map(
    (dispatch) => inScopeCell(dispatch, evidenceByCell.get(dispatch.cellKey)),
  );
  const dispatchByCell = new Map(execution.dispatches.map((entry) => [entry.cellKey, entry]));

  const ports = localAssemblyPorts({
    inputScope: {
      cellsForRun: () => cells,
      ...(execution.cancelled ? { runCancelled: true } : {}),
    },
    pinning: {
      submissionBaseline: plan.run.record.policy.submissionBaseline as Record<string, unknown>,
      isolationInventory: input.venue.isolationInventory,
      evidenceFor: (cellKey) => {
        const evidence = evidenceByCell.get(cellKey);
        if (evidence?.pinning !== undefined) return evidence.pinning;
        // No fidelity evidence recorded for a cell that did run: report the dispatch count so the
        // bridge can tell "nothing executed" from "nothing was observed". Inventing an admission
        // result here would be the one upgrade the bridge's contract forbids.
        const dispatch = dispatchByCell.get(cellKey);
        return dispatch === undefined ? undefined : { dispatches: dispatch.dispatches };
      },
    },
    ...(input.venue.admissionReceiptFor === undefined
      ? {}
      : { admission: { receiptFor: (cell) => input.venue.admissionReceiptFor!(cell.cellKey) } }),
    cost: {
      costFor: (cell) => evidenceByCell.get(cell.cellKey)?.cost,
      latencyFor: (cell) => evidenceByCell.get(cell.cellKey)?.latencyMs,
    },
    ...(input.venue.trust === undefined ? {} : { trust: input.venue.trust }),
  });

  return assembleMatrix(plan.benchmark.record, plan.run.record, ports);
}
