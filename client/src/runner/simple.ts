import type { RestorationJob, RestorationResult } from '../types/index.js';
import type { Runner, RunnerContext } from './runner.js';

export type RestorationFn = (description: string, context?: Record<string, unknown>) => Promise<string>;

export class SimpleRunner implements Runner {
  constructor(private readonly fn: RestorationFn) {}

  async run(restorationJob: RestorationJob, _context: RunnerContext): Promise<RestorationResult> {
    const data = await this.fn(restorationJob.description, restorationJob.context);
    return { data };
  }
}
