import type {
  RestorerImpl,
  RestorationContext,
  RestorationOutput,
} from '../../types.js';
import type {
  HarnessAdapter,
  IntentSessionInputs,
  DefaultLearningRestorerConfig,
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
export class DefaultLearningRestorerImpl implements RestorerImpl {
  readonly name: string;
  readonly version: string;
  private readonly adapter: HarnessAdapter;
  private readonly pluginRoot: string;

  constructor(config: DefaultLearningRestorerConfig) {
    this.adapter = config.adapter;
    this.name = config.name ?? 'default-learner';
    this.version = config.version ?? '0.1.0-shim';
    this.pluginRoot = config.pluginRoot ?? resolvePluginRoot();
  }

  supports(_spec: { kind: string; type?: 'restoration' | 'evaluation' }): boolean {
    return true;
  }

  async run(ctx: RestorationContext): Promise<RestorationOutput> {
    const window = ctx.intent.window ?? { startTs: 0, endTs: 0 };
    const inputs: IntentSessionInputs = {
      intentId: ctx.intent.id,
      intentCid: ctx.intentCid,
      intentKind: ctx.intent.spec?.kind,
      implStateDir: ctx.implStateDir,
      workingDir: ctx.workingDir,
      windowStartTs: window.startTs,
      windowEndTs: window.endTs,
      msUntilEndTs: ctx.msUntilEndTs(),
      abort: ctx.abort,
    };

    await this.adapter.runIntent(inputs, this.pluginRoot);

    return harvestOutput(ctx.workingDir);
  }
}
