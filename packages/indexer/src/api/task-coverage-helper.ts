/**
 * Pure helper for the /health/task-coverage route. Kept in a sub-module so
 * Vitest can import it without pulling in the `ponder:api` virtual module
 * (which is only resolvable inside a running Ponder process). The route in
 * task-coverage.ts re-exports `computeTaskCoverage` for callers that want
 * to import everything from one path.
 *
 * Issue #567 — see task-coverage.ts header.
 */

export interface TaskCoverageInputs {
  chainId: number;
  onchainNextTaskId: bigint | null;
  maxIndexedTaskId: bigint | null;
  maxAttemptTaskId: bigint | null;
  gapThreshold: number;
}

export interface TaskCoverageResult {
  chainId: number;
  onchainNextTaskId: string | null;
  maxIndexedTaskId: string | null;
  maxAttemptTaskId: string | null;
  taskGap: number | null;
  attemptGap: number | null;
  status: 'ok' | 'degraded' | 'unknown';
  httpStatus: 200 | 503;
}

/**
 * Compute the indexer's task-coverage health relative to the on-chain
 * `nextTaskId()`. Pure — all I/O happens in the Hono route in task-coverage.ts.
 *
 * Semantics:
 *   - `lastAllocatedOnchain = onchainNextTaskId - 1n` (the id of the most
 *     recently created task; -1n if no tasks exist yet).
 *   - `taskGap   = lastAllocatedOnchain - (maxIndexedTaskId  ?? -1n)`
 *   - `attemptGap= lastAllocatedOnchain - (maxAttemptTaskId  ?? -1n)`
 *
 * Status:
 *   - 'unknown' (503) when onchainNextTaskId is null (RPC unavailable).
 *   - 'ok' (200) when both gaps are non-null and ≤ gapThreshold.
 *   - 'degraded' (503) when at least one gap exceeds the threshold.
 *
 * Bigint outputs are serialised to decimal strings; gap values fit in a JS
 * number because they are bounded by the threshold check at the call site.
 */
export function computeTaskCoverage(input: TaskCoverageInputs): TaskCoverageResult {
  const {
    chainId,
    onchainNextTaskId,
    maxIndexedTaskId,
    maxAttemptTaskId,
    gapThreshold,
  } = input;

  if (onchainNextTaskId === null) {
    return {
      chainId,
      onchainNextTaskId: null,
      maxIndexedTaskId: maxIndexedTaskId === null ? null : maxIndexedTaskId.toString(),
      maxAttemptTaskId: maxAttemptTaskId === null ? null : maxAttemptTaskId.toString(),
      taskGap: null,
      attemptGap: null,
      status: 'unknown',
      httpStatus: 503,
    };
  }

  const lastAllocated = onchainNextTaskId - 1n; // -1n when onchainNextTaskId === 0n
  const taskMax = maxIndexedTaskId ?? -1n;
  const attemptMax = maxAttemptTaskId ?? -1n;

  const taskGapBig = lastAllocated - taskMax;
  const attemptGapBig = lastAllocated - attemptMax;

  // The gap is bounded by the on-chain task count (≪ Number.MAX_SAFE_INTEGER
  // in any realistic scenario), so Number() is safe.
  const taskGap = Number(taskGapBig);
  const attemptGap = Number(attemptGapBig);

  const ok = taskGap <= gapThreshold && attemptGap <= gapThreshold;

  return {
    chainId,
    onchainNextTaskId: onchainNextTaskId.toString(),
    maxIndexedTaskId: maxIndexedTaskId === null ? null : maxIndexedTaskId.toString(),
    maxAttemptTaskId: maxAttemptTaskId === null ? null : maxAttemptTaskId.toString(),
    taskGap,
    attemptGap,
    status: ok ? 'ok' : 'degraded',
    httpStatus: ok ? 200 : 503,
  };
}
