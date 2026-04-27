import type { Runner, RunnerContext } from '@/runner/runner.js';
import type { DesiredState, RestorationResult } from '@/types/index.js';

export interface FakeClaudeOpts {
  script?: (desiredState: DesiredState, context: RunnerContext) => RestorationResult;
}

/**
 * In-process substitute for `ClaudeRunner`. Does not spawn a subprocess.
 * Integration tests wire this in via DI where production uses `ClaudeRunner`.
 */
export function createFakeClaudeRunner(opts: FakeClaudeOpts = {}): Runner {
  return {
    async run(desiredState, context) {
      if (opts.script) return opts.script(desiredState, context);
      return {
        data: 'fake-claude-default',
      } satisfies RestorationResult;
    },
  };
}
