/**
 * Read-only task-run port consumed by the status/build endpoints (#1584).
 *
 * The API build functions depend on this neutral interface rather than on a
 * concrete store class. `Store.taskRunReadModel()` is the factory that hands
 * one to the composition seam (`api/gather-status.ts`).
 */
import type { PersistedTaskRun, TaskRunState } from './task-run.js';

export interface TaskRunReadModel {
  /** All in-flight task runs (not in any terminal state). */
  getInFlight(): PersistedTaskRun[];
  /** All task runs in a given state. */
  getByState(state: TaskRunState): PersistedTaskRun[];
  /** Minimal gating projection: phase evidence + delivery tx per completed run. */
  getGatingRows(): Array<{ phasesJson: string | null; deliveredTxHash: string | null }>;
}
