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
 * Originally scoped to SWE-rebench v2 only; extended to support any
 * restoration SolverType so operators can configure hermes-agent for
 * prediction.v1, swe-rebench-v2.v1, or future SolverTypes via the
 * joinedSolverNets harness field (jinn-mono-wyy6 Task 6).
 */
export class HermesHarness implements Harness {
  readonly name = HERMES_AGENT_HARNESS;
  readonly version: string;
  private readonly adapter: HermesHarnessAdapter;

  constructor(config: HermesHarnessConfig) {
    this.adapter = config.adapter;
    this.version = config.version ?? '0.1.0';
  }

  supports(spec: { solverType: string; role?: 'restoration' | 'evaluation' }): boolean {
    // Hermes handles any restoration task. Evaluation is not supported: Hermes
    // has no evaluator-side plugins (verdict signing, checker contracts).
    // When operator config selects hermes-agent for a specific SolverType via
    // joinedSolverNets[<cid>].harness, the HarnessRegistry dispatch routes
    // here via solverTypeHarnesses. First-match dispatch is suppressed for
    // SolverTypes that have first-party specialist harnesses (e.g.
    // prediction-v1-baseline) since those specialists register before hermes-agent.
    return spec.role !== 'evaluation';
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
