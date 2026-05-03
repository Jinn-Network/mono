import type { ExecutionAdapter } from '../../src/adapters/adapter.js';
import type { TaskRequest, TaskResult } from '../../src/types/index.js';

/**
 * Small Task-first harness helper retained for older e2e imports.
 * It watches Tasks, claims one into an internal requestId, and submits the
 * provided Solution through the adapter.
 */
export class TaskFirstHarnessLoop {
  constructor(private readonly adapter: ExecutionAdapter) {}

  async claimNextTask(): Promise<TaskRequest> {
    const iterator = this.adapter.watchForTasks()[Symbol.asyncIterator]();
    try {
      const next = await iterator.next();
      if (next.done) throw new Error('watchForTasks ended before yielding a Task');
      return this.adapter.claimTask(next.value.taskId);
    } finally {
      await iterator.return?.();
    }
  }

  async submit(requestId: string, result: TaskResult): Promise<void> {
    await this.adapter.submitResult(requestId, result);
  }
}
