import type { HarnessContext } from '@jinn-network/sdk/harness';
import type { HarnessAdapter } from '../harness.js';
import type { ExecuteResult } from './execute.js';
import type { StrategyResult } from './strategize.js';

export type DebriefVerdict = 'yes' | 'no' | 'partial';

export interface DebriefResult {
  successCriteriaMet: DebriefVerdict;
  rationale: string;
}

export async function runDebrief(args: {
  ctx: HarnessContext;
  harness: HarnessAdapter;
  execute: ExecuteResult;
  strategy: StrategyResult;
}): Promise<DebriefResult> {
  const { ctx, harness, execute, strategy } = args;
  return harness.promptForJson<DebriefResult>({
    promptId: 'debrief',
    systemPrompt:
      'Decide whether the frozen success criteria were met. Be honest.',
    userPrompt: JSON.stringify({ task: ctx.task, strategy, execute }),
    budgetMs: Math.min(ctx.msUntilEndTs(), 15_000),
    abort: ctx.abort,
  });
}
