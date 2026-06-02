/**
 * Train-sequence builder with the no-train/test-overlap guard for the
 * train-arm slope e2e (issue #822, AC#2).
 *
 * The learner-full-cycle e2e drives `runCycle` DIRECTLY (it does not post tasks
 * through the generator), so the generator's `excludeHeldOutSlate` train-stream
 * chokepoint (#817) is BYPASSED. This builder is therefore the load-bearing
 * AC#2 mechanism for the e2e: it selects the N distinct training instances from
 * the pool with the held-out slate excluded, and asserts the resulting
 * sequence is disjoint from the slate (fail-loud, never a silent drop).
 *
 * It reuses `excludeHeldOutSlate` from the #817 primitive rather than
 * reimplementing the exclusion. Selection is deterministic (instance-id sorted)
 * so a given pool yields a stable sequence across runs.
 */

import type { PoolTask } from '../solver-types/_swe-rebench-v2-pool.js';
import { excludeHeldOutSlate } from '../solver-types/_swe-rebench-v2-held-out-slate.js';

/** Thrown when a chosen training sequence intersects the held-out slate (AC#2). */
export class TrainTestOverlapError extends Error {
  constructor(public readonly overlap: string[]) {
    super(
      `train/test overlap: training sequence includes held-out slate instance(s) ` +
        `${overlap.join(', ')} — refusing to train on the eval slate (AC#2). ` +
        `The slate must stay out-of-sample for the slope to mean anything.`,
    );
    this.name = 'TrainTestOverlapError';
  }
}

/** Assert a set of training ids is disjoint from the slate, else throw loud. */
export function assertNoOverlap(trainIds: string[], slateIds: Set<string>): void {
  const overlap = trainIds.filter((id) => slateIds.has(id));
  if (overlap.length > 0) throw new TrainTestOverlapError(overlap);
}

export function buildTrainSequence(args: {
  pool: PoolTask[];
  slateIds: Set<string>;
  /** Number of distinct training tasks (= N training cycles). */
  count: number;
  /**
   * Optional explicit, hand-picked instance_ids (in order). When set, the
   * builder still runs the no-overlap guard and resolves each id against the
   * pool — used to fail-loud on a hand-edited sequence that overlaps the slate.
   */
  explicitIds?: string[];
}): PoolTask[] {
  const eligible = excludeHeldOutSlate(args.pool, args.slateIds);
  const byId = new Map(eligible.map((t) => [t.instance_id, t]));

  if (args.explicitIds) {
    // Guard the hand-picked sequence against the slate BEFORE resolving, so a
    // slate-overlapping id is a TrainTestOverlapError, not a "not eligible".
    assertNoOverlap(args.explicitIds, args.slateIds);
    return args.explicitIds.map((id) => {
      const task = byId.get(id);
      if (!task) {
        throw new Error(`explicit training instance ${id} not in the eligible pool`);
      }
      return task;
    });
  }

  // Deterministic selection: instance-id sorted, first `count`.
  const sorted = [...eligible].sort((a, b) => a.instance_id.localeCompare(b.instance_id));
  if (sorted.length < args.count) {
    throw new Error(
      `train sequence needs ${args.count} distinct tasks but only ${sorted.length} eligible ` +
        `(pool size ${args.pool.length} minus ${args.slateIds.size} held-out slate instance(s))`,
    );
  }
  const picked = sorted.slice(0, args.count);
  assertNoOverlap(picked.map((t) => t.instance_id), args.slateIds);
  return picked;
}
