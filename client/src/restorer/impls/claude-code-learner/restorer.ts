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
 * (`await impl.run(ctx)`) into the harness adapter + markdown plugin.
 *
 * `supports()` returns true for any non-evaluation kind. `ClaudeCodeLearnerWrapper`
 * (./wrapper.ts) is the first-match dispatcher that delegates Execute to a
 * kind-specific specialist when one exists; this shim runs the plugin's full
 * pipeline when no specialist matches.
 */
export class ClaudeCodeLearnerImpl implements RestorerImpl {
  readonly name: string;
  readonly version: string;
  private readonly adapter: HarnessAdapter;
  private readonly pluginRoot: string;
  /**
   * Pre-built serialised slot registry (Path 1 plug-ins) threaded into the
   * harness via `JINN_SLOT_REGISTRY_JSON`. Constructed once at daemon boot
   * from `config.learnerPlugIns[]`. See plan Task 5.
   */
  private readonly slotRegistryJson: string | undefined;

  constructor(
    config: ClaudeCodeLearnerConfig & { slotRegistryJson?: string },
  ) {
    this.adapter = config.adapter;
    this.name = config.name ?? 'claude-code-learner';
    this.version = config.version ?? '0.1.0-shim';
    this.pluginRoot = config.pluginRoot ?? resolvePluginRoot();
    this.slotRegistryJson = config.slotRegistryJson;
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
    // Merge the pre-built slot registry (if any) into adapterEnv so the
    // session-start hook in the harness writes it to slots.json.
    const adapterEnvMerged: Record<string, string> = { ...adapterEnv };
    if (this.slotRegistryJson) {
      adapterEnvMerged.JINN_SLOT_REGISTRY_JSON = this.slotRegistryJson;
    }

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
      adapterEnv:
        Object.keys(adapterEnvMerged).length > 0 ? adapterEnvMerged : undefined,
    };

    await this.adapter.runIntent(inputs, this.pluginRoot);

    // Pass the phase-range hint (if any) through to harvestOutput so that
    // a pre-execute or post-execute pass only validates the artifacts that
    // the coordinator was asked to produce for that pass.
    const phaseRange = adapterEnv['JINN_CLAUDE_CODE_LEARNER_PHASE_RANGE'];
    return harvestOutput(ctx.workingDir, phaseRange);
  }
}
