/**
 * prediction.v1 dashboard data assembly.
 *
 * Uses the generic task-run read model as the first operator-visible lifecycle
 * source. Envelope projections remain the richer corpus source once production
 * writes them.
 */

import type { PersistedTaskRun } from '../types/task-run.js';
import type { TaskRunReadModel } from '../types/task-run-read-model.js';
import type { PredictionOperatorStatus } from '../solver-nets/prediction-operator-ux.js';
import { taskRunRoutingKey } from './task-run-routing.js';

/**
 * Operator-mode visible roles. The launcher is configured per-net but is
 * intentionally omitted from operator-mode status payloads — strict mode
 * separation per spec/2026-05-05-launcher-role-and-mode.md §6.3. Filtering
 * happens at the gather-status API boundary so this narrow type is the one
 * the SPA reads.
 */
export type OperatorVisibleRole = 'solving' | 'evaluating';

/**
 * API-facing variant of {@link PredictionOperatorStatus} with `solverNet.roles`
 * narrowed to operator-visible roles only (no `'launching'`). Built from the
 * full operator status by gather-status before being exposed via /v1/status.
 */
export type PredictionOperatorStatusForApi = Omit<PredictionOperatorStatus, 'solverNet'> & {
  solverNet: Omit<PredictionOperatorStatus['solverNet'], 'roles'> & {
    roles: OperatorVisibleRole[];
  };
};

const RECENT_LIMIT = 5;

export interface PredictionV1TaskRunSummary {
  requestId: string;
  taskId: string | null;
  taskCid: string;
  state: string;
  taskRole: 'restoration' | 'evaluation' | null;
  implName: string | null;
  windowStartTs: number;
  windowEndTs: number;
  runStartedAt: number | null;
  stateUpdatedAt: number;
  manifestCid: string | null;
  deliveryTxHash: string | null;
  failureReason: string | null;
}

export interface PredictionV1Status {
  operator: PredictionOperatorStatusForApi | null;
  operatorError?: string;
  totals: {
    observedTasks: number;
    activeTaskRuns: number;
    solutions: number;
    verdicts: number;
    /**
     * Sum of `settledFailed` and `localErrors`. Retained for callers that
     * still want the rolled-up count; new surfaces should prefer the split
     * fields to align with the public explorer.
     */
    failed: number;
    /** FAILED runs whose delivery tx landed on-chain (settled failure). */
    settledFailed: number;
    /** FAILED runs that never reached the marketplace (local engine error). */
    localErrors: number;
    /**
     * RACE_LOST runs — the on-chain slot was pruned by another operator
     * before this operator did any work. Excluded from `failed` so the
     * dashboard's FAILED counter only reflects attempted runs (#896).
     */
    raceLost: number;
  };
  latest: {
    taskAt: number | null;
    solutionAt: number | null;
    verdictAt: number | null;
  };
  recentTasks: PredictionV1TaskRunSummary[];
  recentSolutions: PredictionV1TaskRunSummary[];
  recentVerdicts: PredictionV1TaskRunSummary[];
}

export interface GatherPredictionV1StatusOptions {
  operator?: PredictionOperatorStatusForApi | null;
  operatorError?: string;
}

export function gatherPredictionV1Status(
  runs: TaskRunReadModel,
  options: GatherPredictionV1StatusOptions = {},
): PredictionV1Status {
  const inFlight = runs.getInFlight().filter(isPredictionV1Run);
  const complete = runs.getByState('COMPLETE').filter(isPredictionV1Run);
  const failed = runs.getByState('FAILED').filter(isPredictionV1Run);
  const raceLost = runs.getByState('RACE_LOST').filter(isPredictionV1Run);
  const allRuns = [...inFlight, ...complete, ...failed, ...raceLost];
  const allRecent = [...allRuns].sort((a, b) => b.stateUpdatedAt - a.stateUpdatedAt);
  const solutions = complete
    .filter((run) => run.taskRole !== 'evaluation')
    .sort((a, b) => b.stateUpdatedAt - a.stateUpdatedAt);
  const verdicts = complete
    .filter((run) => run.taskRole === 'evaluation')
    .sort((a, b) => b.stateUpdatedAt - a.stateUpdatedAt);
  const settledFailed = failed.filter((run) => run.deliveryTxHash !== null);
  const localErrors = failed.filter((run) => run.deliveryTxHash === null);

  return {
    operator: options.operator ?? null,
    ...(options.operatorError ? { operatorError: options.operatorError } : {}),
    totals: {
      observedTasks: distinctTaskCount(allRuns),
      activeTaskRuns: inFlight.length,
      solutions: solutions.length,
      verdicts: verdicts.length,
      failed: failed.length,
      settledFailed: settledFailed.length,
      localErrors: localErrors.length,
      raceLost: raceLost.length,
    },
    latest: {
      taskAt: latestAt(allRuns),
      solutionAt: latestAt(solutions),
      verdictAt: latestAt(verdicts),
    },
    recentTasks: allRecent.slice(0, RECENT_LIMIT).map(toSummary),
    recentSolutions: solutions.slice(0, RECENT_LIMIT).map(toSummary),
    recentVerdicts: verdicts.slice(0, RECENT_LIMIT).map(toSummary),
  };
}

function isPredictionV1Run(run: PersistedTaskRun): boolean {
  return taskRunRoutingKey(run) === 'prediction.v1';
}

function taskIdentity(run: PersistedTaskRun): string {
  return run.taskId ?? run.taskCid;
}

function distinctTaskCount(runs: readonly PersistedTaskRun[]): number {
  return new Set(runs.map(taskIdentity)).size;
}

function latestAt(runs: readonly PersistedTaskRun[]): number | null {
  if (runs.length === 0) return null;
  return Math.max(...runs.map((run) => run.stateUpdatedAt));
}

function toSummary(run: PersistedTaskRun): PredictionV1TaskRunSummary {
  return {
    requestId: run.requestId,
    taskId: run.taskId,
    taskCid: run.taskCid,
    state: run.state,
    taskRole: run.taskRole,
    implName: run.implName,
    windowStartTs: run.windowStartTs,
    windowEndTs: run.windowEndTs,
    runStartedAt: run.runStartedAt,
    stateUpdatedAt: run.stateUpdatedAt,
    manifestCid: run.manifestCid,
    deliveryTxHash: run.deliveryTxHash,
    failureReason: run.failureReason,
  };
}
