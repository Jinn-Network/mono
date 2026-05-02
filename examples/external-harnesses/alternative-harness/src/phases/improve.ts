import type { HarnessContext } from '@jinn-network/sdk/harness';
import type { HarnessAdapter } from '../harness.js';
import type { DebriefResult } from './debrief.js';

export interface ImproveResult {
  mutations: ReadonlyArray<{ path: string; description: string }>;
}

/**
 * Mutates impl-state under `ctx.implStateDir` based on what debrief
 * surfaced. The example returns empty mutations; real impls write
 * playbooks, calibration tables, or skill snippets.
 */
export async function runImprove(args: {
  ctx: HarnessContext;
  harness: HarnessAdapter;
  debrief: DebriefResult;
}): Promise<ImproveResult> {
  const { ctx, harness, debrief } = args;
  return harness.promptForJson<ImproveResult>({
    promptId: 'improve',
    systemPrompt:
      'Propose minimal mutations to impl-state that would help the next attempt.',
    userPrompt: JSON.stringify({
      implStateDir: ctx.implStateDir,
      debrief,
    }),
    budgetMs: Math.min(ctx.msUntilEndTs(), 10_000),
    abort: ctx.abort,
  });
}
