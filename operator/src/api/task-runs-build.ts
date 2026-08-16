import type { PersistedTaskRun } from '../types/task-run.js';
import type { TaskRunReadModel } from '../types/task-run-read-model.js';
import type { VerdictTallyResult } from '../archive/types.js';
import { deriveSolveOutcome, deriveEvaluateOutcome, type RunOutcome } from './run-outcome.js';

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
  runStartedAt: number | null;
  stateUpdatedAt: number;
  manifestCid: string | null;
  deliveryTxHash: string | null;
  failureReason: string | null;
  /**
   * Task-relative outcome (spec/2026-05-22-run-outcome.md): the network's
   * verdict on this run, distinct from the technical `state`. `null` until
   * enriched (and for non-COMPLETE runs). Enriched in the async status path
   * via `applyOutcomes`; the pure `toSummary` seeds it to `null`.
   */
  outcome: RunOutcome;
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
    /**
     * Task runs that terminated in RACE_LOST — the on-chain slot was pruned
     * by another operator (TCMaxVerdictsReached, TCAttemptAlreadyFinalized,
     * …) before this operator did any work. Deliberately excluded from
     * `failed` so the dashboard's FAILED counter only reflects runs the
     * operator actually attempted. See issue #896.
     */
    raceLost: number;
  };
  inFlight: TaskRunSummary[];
  recentTasks: TaskRunSummary[];
}

export function gatherTaskRunsStatus(runs: TaskRunReadModel): TaskRunsStatus {
  const inFlight = runs.getInFlight();
  const complete = runs.getByState('COMPLETE');
  const failed = runs.getByState('FAILED');
  const raceLost = runs.getByState('RACE_LOST');
  // race-loss rows belong in the recentTasks feed so operators can audit
  // them, but they must NOT be folded into `failed` (#896).
  const allRuns = [...inFlight, ...complete, ...failed, ...raceLost];
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
      raceLost: raceLost.length,
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
    runStartedAt: run.runStartedAt,
    stateUpdatedAt: run.stateUpdatedAt,
    manifestCid: run.manifestCid,
    deliveryTxHash: run.deliveryTxHash,
    failureReason: run.failureReason,
    outcome: null,
  };
}

/**
 * Mutates each run's `outcome` in place from the network's verdict tallies
 * (spec/2026-05-22-run-outcome.md). Solve runs use the strict-majority quorum;
 * evaluation runs defer to `'awaiting'` today (the operator-verdict join is a
 * follow-up — spec §6), so we pass `operatorPassed = undefined`.
 *
 * A run with no matching tally entry keeps `deriveSolveOutcome`'s COMPLETE→
 * `'awaiting'` (never a wrong `'fail'`); a non-COMPLETE run stays `null`.
 */
export function applyOutcomes(
  runs: TaskRunSummary[],
  tallies: Map<string, VerdictTallyResult>,
): void {
  for (const r of runs) {
    const tally = r.taskId ? tallies.get(r.taskId) : undefined;
    if (r.taskRole === 'evaluation') {
      r.outcome = deriveEvaluateOutcome(r.state, undefined, tally);
    } else {
      r.outcome = deriveSolveOutcome(r.state, tally);
    }
  }
}
