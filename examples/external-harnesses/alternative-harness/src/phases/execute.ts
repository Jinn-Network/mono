import type { HarnessContext } from '@jinn-network/sdk/harness';
import type { HarnessAdapter } from '../harness.js';
import type { PlanResult } from './plan.js';
import type { StrategyResult } from './strategize.js';

export type ExecuteReturnReason =
  | 'all-steps-completed'
  | 'time-budget-exhausted'
  | 'aborted';

export interface ExecuteResult {
  stepsCompleted: ReadonlyArray<string>;
  stepsFailed: ReadonlyArray<string>;
  returnReason: ExecuteReturnReason;
}

export async function runExecute(args: {
  ctx: HarnessContext;
  harness: HarnessAdapter;
  plan: PlanResult;
  strategy: StrategyResult;
}): Promise<ExecuteResult> {
  const { ctx, harness, plan, strategy } = args;
  return harness.promptForJson<ExecuteResult>({
    promptId: 'execute',
    systemPrompt:
      'Carry out the planned steps. Return early when success criteria are met.',
    userPrompt: JSON.stringify({ task: ctx.task, plan, strategy }),
    // Execute gets the largest budget — leave some room for debrief.
    budgetMs: Math.min(ctx.msUntilEndTs(), 90_000),
    abort: ctx.abort,
  });
}
