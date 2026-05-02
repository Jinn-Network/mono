import type { Task } from '../../types/task.js';

/** Eval `Task.context` key for the restoration job's intended-state IPFS CID (not the eval job's). */
export const RESTORATION_TASK_CID_CONTEXT_KEY = 'restorationTaskCid' as const;

/**
 * Eval `Task.context` key for the restoration envelope's IPFS CID.
 * Set by the daemon when creating evaluation jobs so evaluators can populate the
 * `restorationEnvelope.cid` back-reference in the verdict payload without a
 * synchronous IPFS round-trip at verdict time.
 */
export const RESTORATION_ENVELOPE_CID_CONTEXT_KEY = 'restorationEnvelopeCid' as const;

/**
 * Resolve the expected restoration task CID for `integrity.signedTask_ref`.
 * Test-only overrides win; otherwise the value must be present in `context`.
 * There is no fallback to the evaluation job's `taskCid` (wrong reference).
 */
export function resolveExpectedRestorationTaskCid(
  task: Task,
  testDeps?: { expectedTaskCid?: string },
): { kind: 'resolved'; cid: string } | { kind: 'missing' } {
  if (testDeps?.expectedTaskCid) {
    return { kind: 'resolved', cid: testDeps.expectedTaskCid };
  }
  const v = task.context?.[RESTORATION_TASK_CID_CONTEXT_KEY];
  if (typeof v === 'string' && v.length > 0) {
    return { kind: 'resolved', cid: v };
  }
  return { kind: 'missing' };
}
