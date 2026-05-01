import type { RestorationContext } from '@jinn-network/restorer-sdk';
import type { HarnessAdapter } from '../harness.js';
import type { ExecuteResult } from './execute.js';
import type { StrategyResult } from './strategize.js';

export type DebriefVerdict = 'yes' | 'no' | 'partial';

export interface DebriefResult {
  successCriteriaMet: DebriefVerdict;
  rationale: string;
}

export async function runDebrief(args: {
  ctx: RestorationContext;
  harness: HarnessAdapter;
  execute: ExecuteResult;
  strategy: StrategyResult;
}): Promise<DebriefResult> {
  const { ctx, harness, execute, strategy } = args;
  return harness.promptForJson<DebriefResult>({
    promptId: 'debrief',
    systemPrompt:
      'Decide whether the frozen success criteria were met. Be honest.',
    userPrompt: JSON.stringify({ intent: ctx.intent, strategy, execute }),
    budgetMs: Math.min(ctx.msUntilEndTs(), 15_000),
    abort: ctx.abort,
  });
}
