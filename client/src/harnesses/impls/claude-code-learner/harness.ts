import type {
  Harness,
  HarnessContext,
  Solution,
} from '../../types.js';
import type {
  HarnessAdapter,
  TaskSessionInputs,
  ClaudeCodeLearnerConfig,
} from './types.js';
import { resolvePluginRoot } from './plugin-path.js';
import { harvestOutput } from './harvest.js';

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

  constructor(config: ClaudeCodeLearnerConfig) {
    this.adapter = config.adapter;
    this.name = config.name ?? 'claude-code-learner';
    this.version = config.version ?? '0.1.0-shim';
    this.pluginRoot = config.pluginRoot ?? resolvePluginRoot();
  }

  supports(spec: { solverType: string; role?: 'restoration' | 'evaluation' }): boolean {
    return spec.role !== 'evaluation';
  }

  async run(ctx: HarnessContext): Promise<Solution> {
    const window = ctx.task.window ?? { startTs: 0, endTs: 0 };
    const inputs: TaskSessionInputs = {
      taskId: ctx.task.id,
      taskCid: ctx.taskCid,
      solverType: ctx.task.solverType,
      taskBody: ctx.task as TaskSessionInputs['taskBody'],
      implStateDir: ctx.implStateDir,
      workingDir: ctx.workingDir,
      pluginRoots: [...(ctx.solverPluginRoots ?? [])],
      windowStartTs: window.startTs,
      windowEndTs: window.endTs,
      msUntilEndTs: ctx.msUntilEndTs(),
      abort: ctx.abort,
    };

    await this.adapter.runTask(inputs, this.pluginRoot);

    return harvestOutput(ctx.workingDir);
  }
}
