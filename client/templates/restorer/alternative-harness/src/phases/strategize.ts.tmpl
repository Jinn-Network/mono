import type { RestorationContext } from '@jinn-network/restorer-sdk';
import type { HarnessAdapter } from '../harness.js';
import type { OrientResult } from './orient.js';

export type TimingPosture =
  | 'early-return'
  | 'hold-and-revise'
  | 'continuous-observation';

export interface StrategyResult {
  approach: string;
  successCriteria: string;
  timingPosture: TimingPosture;
}

export async function runStrategize(args: {
  ctx: RestorationContext;
  harness: HarnessAdapter;
  orient: OrientResult;
}): Promise<StrategyResult> {
  const { ctx, harness, orient } = args;
  return harness.promptForJson<StrategyResult>({
    promptId: 'strategize',
    systemPrompt: 'You commit to one approach and freeze success criteria.',
    userPrompt: JSON.stringify({ intent: ctx.intent, orient }),
    budgetMs: Math.min(ctx.msUntilEndTs(), 20_000),
    abort: ctx.abort,
  });
}
