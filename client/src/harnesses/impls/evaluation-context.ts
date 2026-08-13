import type { Task } from '../../types/task.js';

/** Eval `Task.context` key for the solution job's intended-state IPFS CID (not the eval job's). */
export const SOLUTION_TASK_CID_CONTEXT_KEY = 'solutionTaskCid' as const;
export const RESTORATION_TASK_CID_CONTEXT_KEY = 'restorationTaskCid' as const;
/** Strict, lifecycle-admitted context for the Autopilot semantic evaluator. */
export const AUTOPILOT_EVALUATION_CONTEXT_KEY = 'autopilotEvaluation' as const;
/** Strict, host-admitted context for the independent Issue Relay evaluator. */
export const ISSUE_RELAY_EVALUATION_CONTEXT_KEY =
  'issueRelayEvaluation' as const;

/**
 * Eval `Task.context` key for the solution envelope's IPFS CID.
 * Set by the daemon when creating evaluation jobs so evaluators can populate the
 * `solutionEnvelope.cid` back-reference in the verdict payload without a
 * synchronous IPFS round-trip at verdict time.
 */
export const SOLUTION_ENVELOPE_CID_CONTEXT_KEY = 'solutionEnvelopeCid' as const;
export const RESTORATION_ENVELOPE_CID_CONTEXT_KEY = 'restorationEnvelopeCid' as const;

/**
 * Resolve the expected solution task CID for `integrity.signedTask_ref`.
 * Test-only overrides win; otherwise the value must be present in `context`.
 * There is no fallback to the evaluation job's `taskCid` (wrong reference).
 */
export function resolveExpectedSolutionTaskCid(
  task: Task,
  testDeps?: { expectedTaskCid?: string },
): { kind: 'resolved'; cid: string } | { kind: 'missing' } {
  if (testDeps?.expectedTaskCid) {
    return { kind: 'resolved', cid: testDeps.expectedTaskCid };
  }
  const solutionCid = task.context?.[SOLUTION_TASK_CID_CONTEXT_KEY];
  if (typeof solutionCid === 'string' && solutionCid.length > 0) {
    return { kind: 'resolved', cid: solutionCid };
  }
  const legacyCid = task.context?.[RESTORATION_TASK_CID_CONTEXT_KEY];
  if (typeof legacyCid === 'string' && legacyCid.length > 0) {
    return { kind: 'resolved', cid: legacyCid };
  }
  return { kind: 'missing' };
}

export function resolveExpectedRestorationTaskCid(
  task: Task,
  testDeps?: { expectedTaskCid?: string },
): { kind: 'resolved'; cid: string } | { kind: 'missing' } {
  return resolveExpectedSolutionTaskCid(task, testDeps);
}


export function resolveSolutionEnvelopeCid(task: Task): string | undefined {
  const solutionCid = task.context?.[SOLUTION_ENVELOPE_CID_CONTEXT_KEY];
  if (typeof solutionCid === 'string' && solutionCid.length > 0) return solutionCid;
  const legacyCid = task.context?.[RESTORATION_ENVELOPE_CID_CONTEXT_KEY];
  return typeof legacyCid === 'string' && legacyCid.length > 0 ? legacyCid : undefined;
}
