/**
 * prediction.v1 dashboard data assembly.
 *
 * Uses the generic task_runs table as the first operator-visible lifecycle
 * source. Envelope projections remain the richer corpus source once production
 * writes them, but task_runs is available in the daemon today.
 */

import type { Store } from '../store/store.js';
import { TaskRunPersistence, type PersistedTaskRun } from '../harnesses/engine/persistence.js';
import type { PredictionOperatorStatus } from '../solver-nets/prediction-operator-ux.js';

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
    failed: number;
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
  store: Store,
  options: GatherPredictionV1StatusOptions = {},
): PredictionV1Status {
  const persistence = new TaskRunPersistence(store.db);
  const inFlight = persistence.getInFlight().filter(isPredictionV1Run);
  const complete = persistence.getByState('COMPLETE').filter(isPredictionV1Run);
  const failed = persistence.getByState('FAILED').filter(isPredictionV1Run);
  const allRuns = [...inFlight, ...complete, ...failed];
  const allRecent = [...allRuns].sort((a, b) => b.stateUpdatedAt - a.stateUpdatedAt);
  const solutions = complete
    .filter((run) => run.taskRole !== 'evaluation')
    .sort((a, b) => b.stateUpdatedAt - a.stateUpdatedAt);
  const verdicts = complete
    .filter((run) => run.taskRole === 'evaluation')
    .sort((a, b) => b.stateUpdatedAt - a.stateUpdatedAt);

  return {
    operator: options.operator ?? null,
    ...(options.operatorError ? { operatorError: options.operatorError } : {}),
    totals: {
      observedTasks: distinctTaskCount(allRuns),
      activeTaskRuns: inFlight.length,
      solutions: solutions.length,
      verdicts: verdicts.length,
      failed: failed.length,
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
  return run.solverType === 'prediction.v1';
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
    stateUpdatedAt: run.stateUpdatedAt,
    manifestCid: run.manifestCid,
    deliveryTxHash: run.deliveryTxHash,
    failureReason: run.failureReason,
  };
}
