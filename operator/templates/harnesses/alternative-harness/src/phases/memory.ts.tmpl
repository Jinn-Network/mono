import type { HarnessContext } from '@jinn-network/sdk/harness';
import type { HarnessAdapter } from '../harness.js';
import type { DebriefResult } from './debrief.js';

export interface MemoryResult {
  kept: number;
  pruned: number;
}

/**
 * Garbage-collects long-term memory. The example returns
 * `{ kept: 0, pruned: 0 }`; real impls trim stale records under
 * `ctx.implStateDir`.
 */
export async function runMemory(args: {
  ctx: HarnessContext;
  harness: HarnessAdapter;
  debrief: DebriefResult;
}): Promise<MemoryResult> {
  const { ctx, harness, debrief } = args;
  return harness.promptForJson<MemoryResult>({
    promptId: 'memory',
    systemPrompt: 'Decide which memory items to keep vs prune.',
    userPrompt: JSON.stringify({
      implStateDir: ctx.implStateDir,
      debrief,
    }),
    budgetMs: Math.min(ctx.msUntilEndTs(), 10_000),
    abort: ctx.abort,
  });
}
