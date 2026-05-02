import type { HarnessContext } from '@jinn-network/sdk/harness';
import type { HarnessAdapter } from '../harness.js';
import type { OrientResult } from './orient.js';
import type { StrategyResult } from './strategize.js';

export interface PlanResult {
  steps: ReadonlyArray<{ id: string; description: string }>;
}

export async function runPlan(args: {
  ctx: HarnessContext;
  harness: HarnessAdapter;
  strategy: StrategyResult;
  orient: OrientResult;
}): Promise<PlanResult> {
  const { ctx, harness, strategy, orient } = args;
  return harness.promptForJson<PlanResult>({
    promptId: 'plan',
    systemPrompt:
      'Decompose the chosen approach into a small ordered list of steps.',
    userPrompt: JSON.stringify({ task: ctx.task, strategy, orient }),
    budgetMs: Math.min(ctx.msUntilEndTs(), 15_000),
    abort: ctx.abort,
  });
}
