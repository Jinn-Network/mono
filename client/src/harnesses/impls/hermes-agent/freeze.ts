// client/src/harnesses/impls/hermes-agent/freeze.ts
import { runHarnessWithFreezeFence } from '../../../daemon/freeze-fence.js';
import type { Harness, HarnessContext, Solution } from '../../types.js';
import type { HermesHarness } from './harness.js';

/**
 * Wraps a HermesHarness run with the daemon hash-fence. In frozen mode,
 * HERMES_HOME (= ctx.implStateDir) is snapshotted before the run and
 * re-hashed after; mismatch → rollback + envelope rejection.
 *
 * In train mode, the wrapper is pass-through.
 */
export async function runHermesWithFreezeFence(
  harness: HermesHarness,
  ctx: HarnessContext,
): Promise<Solution> {
  const result = await runHarnessWithFreezeFence(harness as unknown as Harness, ctx);
  if (!result.ok) {
    throw new Error(`hermes-agent: freeze contract violated: ${JSON.stringify(result.violation)}`);
  }
  return result.output as Solution;
}
