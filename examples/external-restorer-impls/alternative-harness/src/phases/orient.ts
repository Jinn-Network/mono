import type { RestorationContext } from '@jinn-network/restorer-sdk';
import type { HarnessAdapter } from '../harness.js';

export interface OrientResult {
  topics: ReadonlyArray<{ name: string; summary: string }>;
}

export async function runOrient(args: {
  ctx: RestorationContext;
  harness: HarnessAdapter;
}): Promise<OrientResult> {
  const { ctx, harness } = args;
  return harness.promptForJson<OrientResult>({
    promptId: 'orient',
    systemPrompt:
      'You are an info-gathering subagent for a Jinn restoration intent.',
    userPrompt: JSON.stringify({ intent: ctx.intent }),
    budgetMs: Math.min(ctx.msUntilEndTs(), 30_000),
    abort: ctx.abort,
  });
}
