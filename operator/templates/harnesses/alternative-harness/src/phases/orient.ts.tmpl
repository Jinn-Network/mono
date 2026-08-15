import type { HarnessContext } from '@jinn-network/sdk/harness';
import type { HarnessAdapter } from '../harness.js';

export interface OrientResult {
  topics: ReadonlyArray<{ name: string; summary: string }>;
}

export async function runOrient(args: {
  ctx: HarnessContext;
  harness: HarnessAdapter;
}): Promise<OrientResult> {
  const { ctx, harness } = args;
  return harness.promptForJson<OrientResult>({
    promptId: 'orient',
    systemPrompt:
      'You are an info-gathering subagent for a Jinn restoration Task.',
    userPrompt: JSON.stringify({ task: ctx.task }),
    budgetMs: Math.min(ctx.msUntilEndTs(), 30_000),
    abort: ctx.abort,
  });
}
