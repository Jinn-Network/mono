import type { Store } from '../store/store.js';
import { TaskRunPersistence, type PersistedTaskRun } from '../harnesses/engine/persistence.js';

const RECENT_LIMIT = 10;

export interface TaskRunSummary {
  requestId: string;
  taskId: string | null;
  taskCid: string;
  solverType: string | null;
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

export interface TaskRunsStatus {
  totals: {
    observedTasks: number;
    activeTaskRuns: number;
    completed: number;
    failed: number;
  };
  inFlight: TaskRunSummary[];
  recentTasks: TaskRunSummary[];
}

export function gatherTaskRunsStatus(store: Store): TaskRunsStatus {
  const persistence = new TaskRunPersistence(store.db);
  const inFlight = persistence.getInFlight();
  const complete = persistence.getByState('COMPLETE');
  const failed = persistence.getByState('FAILED');
  const allRuns = [...inFlight, ...complete, ...failed];
  const allRecent = [...allRuns].sort((a, b) => b.stateUpdatedAt - a.stateUpdatedAt);

  return {
    totals: {
      observedTasks: distinctTaskCount(allRuns),
      activeTaskRuns: inFlight.length,
      completed: complete.length,
      failed: failed.length,
    },
    inFlight: [...inFlight]
      .sort((a, b) => b.stateUpdatedAt - a.stateUpdatedAt)
      .map(toSummary),
    recentTasks: allRecent.slice(0, RECENT_LIMIT).map(toSummary),
  };
}

function taskIdentity(run: PersistedTaskRun): string {
  return run.taskId ?? run.taskCid;
}

function distinctTaskCount(runs: readonly PersistedTaskRun[]): number {
  return new Set(runs.map(taskIdentity)).size;
}

function toSummary(run: PersistedTaskRun): TaskRunSummary {
  return {
    requestId: run.requestId,
    taskId: run.taskId,
    taskCid: run.taskCid,
    solverType: run.solverType,
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
