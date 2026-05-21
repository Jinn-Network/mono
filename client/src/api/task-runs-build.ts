import type { Store } from '../store/store.js';
import { TaskRunPersistence, type PersistedTaskRun } from '../harnesses/engine/persistence.js';

/**
 * Cap on how many task runs the /v1/status payload carries. The operator
 * dashboard's Activity table reads this slice; 10 was too tight (an operator
 * with 20+ tasks on the SolverNet would see 6 after dedup against
 * `predictionV1.recentTasks` + filtering by manifestCid). 50 gives enough
 * runway for normal browsing without paginating. Bump when this becomes
 * the bottleneck again — pagination is the eventual right answer.
 */
const RECENT_LIMIT = 50;

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
    solutions: number;
    verdicts: number;
    /**
     * Sum of `settledFailed` and `localErrors`. Retained for callers that
     * still want the rolled-up count, but operator surfaces should prefer
     * the split fields so the on-chain vs. local distinction is visible.
     */
    failed: number;
    /**
     * FAILED task runs whose `delivery_tx_hash` landed on-chain before the
     * run terminated — the marketplace recorded the delivery and a
     * downstream step (claimDelivery, on-chain verdict) marked it as a
     * settled failure. This is the count that should align with the public
     * explorer's per-operator fail count.
     */
    settledFailed: number;
    /**
     * FAILED task runs with no on-chain delivery tx — the run never reached
     * the marketplace (SkippableError, claim-time rejects, runner crashes,
     * recovery aborts). Operator-only debugging signal; not visible on
     * the public explorer.
     */
    localErrors: number;
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
  const solutions = complete.filter((run) => run.taskRole !== 'evaluation');
  const verdicts = complete.filter((run) => run.taskRole === 'evaluation');
  const settledFailed = failed.filter((run) => run.deliveryTxHash !== null);
  const localErrors = failed.filter((run) => run.deliveryTxHash === null);

  return {
    totals: {
      observedTasks: distinctTaskCount(allRuns),
      activeTaskRuns: inFlight.length,
      completed: complete.length,
      solutions: solutions.length,
      verdicts: verdicts.length,
      failed: failed.length,
      settledFailed: settledFailed.length,
      localErrors: localErrors.length,
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
