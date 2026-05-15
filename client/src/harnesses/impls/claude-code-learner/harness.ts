import type {
  Harness,
  HarnessContext,
  Solution,
  ReadyStatus,
} from '../../types.js';
import { CLAUDE_CODE_HARNESS } from '../../names.js';
import type {
  HarnessAdapter,
  TaskSessionInputs,
  ClaudeCodeLearnerConfig,
} from './types.js';
import { resolvePluginRoot } from './plugin-path.js';
import { harvestOutput } from './harvest.js';
import { probeClaudeAuth } from '../../../preflight/claude-auth.js';

/**
 * `Harness` shell. Bridges the engine's dispatch contract
 * (`await impl.run(ctx)`) into the harness adapter + markdown plugin.
 *
 * `supports()` returns true for any non-evaluation SolverType. The registry
 * keeps this Harness as the default, so explicit specialists can still claim
 * their SolverTypes without being wrapped.
 */
export class ClaudeCodeLearnerImpl implements Harness {
  readonly name: string;
  readonly version: string;
  private readonly adapter: HarnessAdapter;
  private readonly pluginRoot: string;
  private readonly claudePath: string;
  private readonly runtimeMode: 'bare' | 'container' | 'docker-compose';

  constructor(config: ClaudeCodeLearnerConfig) {
    this.adapter = config.adapter;
    this.name = config.name ?? CLAUDE_CODE_HARNESS;
    this.version = config.version ?? '0.1.0-shim';
    this.pluginRoot = config.pluginRoot ?? resolvePluginRoot();
    this.claudePath = config.claudePath ?? 'claude';
    this.runtimeMode = config.runtimeMode ?? 'bare';
  }

  async isReady(
    _ctx?: { solverType: string; role?: 'restoration' | 'evaluation' },
  ): Promise<ReadyStatus> {
    const result = probeClaudeAuth({
      context: this.runtimeMode,
      cwd: process.cwd(),
      claudePath: this.claudePath,
    });
    if (result.authenticated) {
      return { ready: true, reason: result.detail };
    }
    const binaryMissing = result.detail.includes('not found on PATH');
    return {
      ready: false,
      reason: result.detail,
      nextStep: binaryMissing
        ? {
            description: 'Install Claude Code from the operator app',
            url: '/v1/setup/claude/install',
          }
        : {
            description: 'Sign in to Claude from the operator app',
            url: '/v1/auth/claude/spawn',
          },
    };
  }

  supports(spec: { solverType: string; role?: 'restoration' | 'evaluation' }): boolean {
    if (spec.role === 'evaluation') return false;
    // These SolverTypes have first-party restoration Harnesses that return
    // typed solutionPayload objects. The learner emits phase artifacts for its
    // own pipeline; letting it claim these specialist tasks can run Claude but
    // fail packaging when the phase artifacts are absent.
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
