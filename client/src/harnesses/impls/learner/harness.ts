import type {
  Harness,
  HarnessContext,
  Solution,
} from '../../types.js';
import { CLAUDE_CODE_HARNESS } from '../../names.js';
import type {
  HarnessAdapter,
  TaskSessionInputs,
  LearnerHarnessConfig,
} from './types.js';
import { resolvePluginRoot } from './plugin-path.js';
import { harvestOutput } from './harvest.js';
import { buildClaudeIsReady } from '../../../preflight/claude-auth.js';

/**
 * `Harness` shell. Bridges the engine's dispatch contract
 * (`await impl.run(ctx)`) into the harness adapter + markdown plugin.
 *
 * `supports()` returns true for any non-evaluation SolverType. The registry
 * keeps this Harness as the default, so explicit specialists can still claim
 * their SolverTypes without being wrapped.
 */
export class LearnerHarness implements Harness {
  readonly name: string;
  readonly version: string;
  private readonly adapter: HarnessAdapter;
  private readonly pluginRoot: string;
  private readonly claudePath: string;
  private readonly runtimeMode: 'bare' | 'container' | 'docker-compose';

  constructor(config: LearnerHarnessConfig) {
    this.adapter = config.adapter;
    this.name = config.name ?? CLAUDE_CODE_HARNESS;
    this.version = config.version ?? '0.1.0-shim';
    this.pluginRoot = config.pluginRoot ?? resolvePluginRoot();
    this.claudePath = config.claudePath ?? 'claude';
    this.runtimeMode = config.runtimeMode ?? 'bare';
  }

  isReady = buildClaudeIsReady({
    getClaudePath: () => this.claudePath,
    getContext: () => this.runtimeMode,
  });

  supports(spec: { solverType: string; role?: 'restoration' | 'evaluation' }): boolean {
    if (spec.role === 'evaluation') return false;
    // These SolverTypes have first-party restoration Harnesses that return
    // typed solutionPayload objects. The learner emits phase artifacts for its
    // own pipeline; letting it claim these specialist tasks can run Claude but
    // fail packaging when the phase artifacts are absent.
    //
    // Architectural debt: this blocklist is the symptom — the learner can't
    // currently handle prediction.v1 / prediction.apy.v0 generically because
    // jinn-prediction-plugin lacks a submission-shape skill the way
    // swe-rebench-v2-runtime has plan/SKILL.md. Once that plugin gets a
    // submission skill and the harvest's prediction.v1 special-path
    // (harvest.ts ~520) is migrated to the generic .execute/solution-payload.json
    // path, this whole branch can be deleted.
    //
    // Related: jinn-mono-kzlj (deferred — Prediction frozen per
    // DR-2026-05-11-a). kzlj is scoped to prediction.v1; the prediction.apy.v0
    // path needs the same migration when the apy SolverNet's freeze lifts
    // (file a sibling bead when that happens). Reopen kzlj + file the apy
    // analogue when the freezes lift.
    if (spec.solverType === 'prediction.v1' || spec.solverType === 'prediction.apy.v0') {
      return false;
    }
    return true;
  }

  async run(ctx: HarnessContext): Promise<Solution> {
    const window = ctx.task.window ?? { startTs: 0, endTs: 0 };
    const inputs: TaskSessionInputs = {
      taskId: ctx.task.id,
      requestId: ctx.requestId,
      taskCid: ctx.taskCid,
      solverType: ctx.task.solverType,
      model: ctx.solverNet?.model,
      claudeModel: ctx.solverNet?.model,
      taskBody: ctx.task as TaskSessionInputs['taskBody'],
      implStateDir: ctx.implStateDir,
      workingDir: ctx.workingDir,
      pluginRoots: [...(ctx.solverPluginRoots ?? [])],
      windowStartTs: window.startTs,
      windowEndTs: window.endTs,
      msUntilEndTs: ctx.msUntilEndTs(),
      abort: ctx.abort,
      mode: ctx.mode,
    };

    await this.adapter.runTask(inputs, this.pluginRoot);

    const solution = await harvestOutput(ctx.workingDir, undefined, ctx.task);
    return {
      ...solution,
      venueRef: { ...solution.venueRef, name: this.name },
    };
  }
}
