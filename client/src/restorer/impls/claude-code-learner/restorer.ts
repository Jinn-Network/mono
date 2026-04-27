import type {
  RestorerImpl,
  RestorationContext,
  RestorationOutput,
} from '../../types.js';
import type {
  HarnessAdapter,
  IntentSessionInputs,
  ClaudeCodeLearnerConfig,
} from './types.js';
import { resolvePluginRoot } from './plugin-path.js';
import { harvestOutput } from './harvest.js';

/**
 * `RestorerImpl` shell. Bridges the engine's dispatch contract
 * (engine.ts:533: `await impl.run(ctx)`) into the harness adapter +
 * markdown plugin shipped by Plan 1.
 *
 * Plan 2 supports() returns true for any kind. Plan 3 wraps this in a
 * first-match-wrapper that delegates Execute to the kind-specific
 * specialist when one exists.
 */
export class ClaudeCodeLearnerImpl implements RestorerImpl {
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

  supports(spec: { kind: string; type?: 'restoration' | 'evaluation' }): boolean {
    return spec.type !== 'evaluation';
  }

  async run(ctx: RestorationContext): Promise<RestorationOutput> {
    return this.runWithAdapterEnv(ctx, {});
  }

  /**
   * Public escape hatch for the ClaudeCodeLearnerWrapper. Threads
   * adapterEnv through IntentSessionInputs so the wrapper can hand
   * the coordinator skill a phase-range hint without mutating
   * process.env (which would not propagate to the spawned harness
   * anyway).
   */
  async runWithAdapterEnv(
    ctx: RestorationContext,
    adapterEnv: Record<string, string>,
  ): Promise<RestorationOutput> {
    const window = ctx.intent.window ?? { startTs: 0, endTs: 0 };
    const inputs: IntentSessionInputs = {
      intentId: ctx.intent.id,
      intentCid: ctx.intentCid,
      intentKind: ctx.intent.spec?.kind,
      intentBody: ctx.intent as IntentSessionInputs['intentBody'],
      implStateDir: ctx.implStateDir,
      workingDir: ctx.workingDir,
      windowStartTs: window.startTs,
      windowEndTs: window.endTs,
      msUntilEndTs: ctx.msUntilEndTs(),
      abort: ctx.abort,
      adapterEnv: Object.keys(adapterEnv).length > 0 ? adapterEnv : undefined,
    };

    await this.adapter.runIntent(inputs, this.pluginRoot);

    // Pass the phase-range hint (if any) through to harvestOutput so that
    // a pre-execute or post-execute pass only validates the artifacts that
    // the coordinator was asked to produce for that pass.
    const phaseRange = adapterEnv['JINN_CLAUDE_CODE_LEARNER_PHASE_RANGE'];
    return harvestOutput(ctx.workingDir, phaseRange);
  }
}
