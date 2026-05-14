// client/src/harnesses/impls/hermes-agent/harness.ts
import type { Harness, HarnessContext, Solution } from '../../types.js';
import { HERMES_AGENT_HARNESS } from '../../names.js';
import type { HermesHarnessAdapter } from './adapter.js';
import { harvestOutput } from '../learner/harvest.js';

export interface HermesHarnessConfig {
  adapter: HermesHarnessAdapter;
  version?: string;
}

/**
 * Hermes Agent harness.
 *
 * Generic restoration harness backed by the Hermes agent runner. Built-in
 * learning loop owned by Hermes (skill self-improvement, memory curation, FTS5
 * session search); Jinn-side learner plugin is NOT loaded. SolverPlugins are
 * mounted via Hermes's mcp_servers + skills config.yaml surface (see
 * config-builder.ts).
 *
 * Scoped to SWE-rebench v2 while the Hermes task prompt, SolverPlugin bundle,
 * and output harvesting are specific to `swe-rebench-v2.v1`.
 */
export class HermesHarness implements Harness {
  readonly name = HERMES_AGENT_HARNESS;
  readonly version: string;
  readonly freezeStateHashIgnore = ['auth', 'auth.json', 'bin/tirith', '.env', 'config.yaml'] as const;
  private readonly adapter: HermesHarnessAdapter;

  constructor(config: HermesHarnessConfig) {
    this.adapter = config.adapter;
    this.version = config.version ?? '0.1.0';
  }

  supports(spec: { solverType: string; role?: 'restoration' | 'evaluation' }): boolean {
    // Hermes currently ships a SWE-rebench v2 task prompt and runtime plugin.
    // Evaluation is not supported: Hermes has no evaluator-side plugins
    // (verdict signing, checker contracts).
    return spec.role !== 'evaluation' && spec.solverType === 'swe-rebench-v2.v1';
  }

  async run(ctx: HarnessContext): Promise<Solution> {
    const window = ctx.task.window ?? { startTs: 0, endTs: 0 };
    await this.adapter.runTask({
      taskId: ctx.task.id,
      requestId: ctx.requestId,
      taskCid: ctx.taskCid,
      solverType: ctx.task.solverType,
      model: ctx.solverNet?.model,
      taskBody: ctx.task as any,
      implStateDir: ctx.implStateDir,
      workingDir: ctx.workingDir,
      pluginRoots: [...(ctx.solverPluginRoots ?? [])],
      windowStartTs: window.startTs,
      windowEndTs: window.endTs,
      msUntilEndTs: ctx.msUntilEndTs(),
      abort: ctx.abort,
      mode: ctx.mode,
    });

    const solution = await harvestOutput(ctx.workingDir, undefined, ctx.task);
    return { ...solution, venueRef: { ...solution.venueRef, name: this.name } };
  }
}
