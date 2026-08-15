import type { Runner, RunnerContext } from '@/runner/runner.js';
import type { Task, TaskResult } from '@/types/index.js';

export interface FakeClaudeOpts {
  script?: (task: Task, context: RunnerContext) => TaskResult;
}

/**
 * In-process substitute for `ClaudeRunner`. Does not spawn a subprocess.
 * Integration tests wire this in via DI where production uses `ClaudeRunner`.
 */
export function createFakeClaudeRunner(opts: FakeClaudeOpts = {}): Runner {
  return {
    async run(task, context) {
      if (opts.script) return opts.script(task, context);
      return {
        data: 'fake-claude-default',
      } satisfies TaskResult;
    },
  };
}
