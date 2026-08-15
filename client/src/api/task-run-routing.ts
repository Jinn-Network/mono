import type { PersistedTaskRun } from '../types/task-run.js';

/**
 * Mirrors the daemon's internal routing-key compatibility logic so status
 * builders can keep classifying persisted-run rows during the
 * `solverType` -> `contractId`/`contractVersion` migration.
 */
export function taskRunRoutingKey(run: PersistedTaskRun): string | undefined {
  if (run.task?.contractId && run.task?.contractVersion) {
    return `${run.task.contractId}.${run.task.contractVersion}`;
  }
  return run.solverType ?? run.task?.solverType ?? undefined;
}
