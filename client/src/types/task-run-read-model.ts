/**
 * Read-only task-run port consumed by the status/build endpoints (#1584).
 *
 * The API build functions depend on this neutral interface rather than on the
 * concrete `TaskRunPersistence` engine class. `TaskRunPersistence` structurally
 * satisfies it; `Store.taskRunReadModel()` is the factory that hands one to the
 * composition seam (`api/gather-status.ts`). This keeps `api/` free of any
 * `store/task-run-persistence` import.
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
