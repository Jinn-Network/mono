import type { Task, TaskResult } from '../types/index.js';
import type { Runner, RunnerContext } from './runner.js';

export type RestorationFn = (description: string, context?: Record<string, unknown>) => Promise<string>;

export class SimpleRunner implements Runner {
  constructor(private readonly fn: RestorationFn) {}

  async run(task: Task, _context: RunnerContext): Promise<TaskResult> {
    const data = await this.fn(task.description, task.context);
    return { data };
  }
}
