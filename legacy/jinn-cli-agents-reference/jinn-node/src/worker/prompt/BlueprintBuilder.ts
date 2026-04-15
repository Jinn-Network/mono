/**
 * BlueprintBuilder - Centralized Prompt Building System
 *
 * This class replaces the fragmented GEMINI.md-based prompt building with a
 * unified, provider-based system that outputs a homomorphic blueprint.
 *
 * Two-phase execution:
 * 1. Context providers run first, building the BlueprintContext
 * 2. Assertion providers run second, with access to the built context
 */

import { workerLogger } from '../../logging/index.js';
import { serializeError } from '../logging/errors.js';
import { DEFAULT_BLUEPRINT_CONFIG } from './config.js';
import { renderBlueprintToProse } from './invariant-renderer.js';
import type {
  BlueprintBuilderConfig,
  BlueprintContext,
  Invariant,
  BooleanInvariant,
  UnifiedBlueprint,
  BuildContext,
  ContextProvider,
  InvariantProvider,
  BlueprintBuildResult,
} from './types.js';
import type { IpfsMetadata } from '../types.js';
import type { RecognitionPhaseResult } from '../recognition_helpers.js';

// Context providers
import { JobContextProvider } from './providers/context/JobContextProvider.js';
import { ProgressCheckpointProvider } from './providers/context/ProgressCheckpointProvider.js';
import { MeasurementContextProvider } from './providers/context/MeasurementContextProvider.js';
import { VentureContextProvider } from './providers/context/VentureContextProvider.js';

// Invariant providers
import {
  SystemInvariantProvider,
  GoalInvariantProvider,
  LearningInvariantProvider,
  CoordinationInvariantProvider,
  StateInvariantProvider,
  StrategyInvariantProvider,
  RecoveryInvariantProvider,
  ToolingInvariantProvider,
  QualityInvariantProvider,
  OutputInvariantProvider,
  CycleInvariantProvider,
} from './providers/invariants/index.js';

/**
 * BlueprintBuilder constructs unified blueprints from multiple providers
 */
export class BlueprintBuilder {
  private contextProviders: ContextProvider[] = [];
  private invariantProviders: InvariantProvider[] = [];
  private config: BlueprintBuilderConfig;

  constructor(config?: Partial<BlueprintBuilderConfig>) {
    this.config = { ...DEFAULT_BLUEPRINT_CONFIG, ...config };
  }

  /**
   * Register a context provider (Phase 1)
   */
  registerContextProvider(provider: ContextProvider): this {
    this.contextProviders.push(provider);
    return this;
  }

  /**
   * Register an invariant provider (Phase 2)
   */
  registerInvariantProvider(provider: InvariantProvider): this {
    this.invariantProviders.push(provider);
    return this;
  }

  /**
   * Build a unified blueprint for the given request
   *
   * @param requestId - The request ID
   * @param metadata - IPFS metadata for the job
   * @param recognition - Recognition phase result (optional)
   * @returns The built blueprint with timing info
   */
  async build(
    requestId: string,
    metadata: IpfsMetadata,
    recognition?: RecognitionPhaseResult | null
  ): Promise<BlueprintBuildResult> {
    const startTime = Date.now();
    const providers: string[] = [];

    // Create the build context
    const buildContext: BuildContext = {
      requestId,
      metadata,
      recognition,
      config: this.config,
    };

    // Phase 1: Build context from context providers
    const context: BlueprintContext = {};
    for (const provider of this.contextProviders) {
      if (!provider.enabled(this.config)) {
        if (this.config.logProviders) {
          workerLogger.debug({ provider: provider.name }, 'Context provider disabled, skipping');
        }
        continue;
      }

      try {
        const providerContext = await provider.provide(buildContext);
        if (providerContext && Object.keys(providerContext).length > 0) {
          // Filter out undefined values to prevent overwriting prior context
          const filtered = Object.fromEntries(
            Object.entries(providerContext).filter(([, v]) => v !== undefined)
          );
          if (Object.keys(filtered).length > 0) {
            Object.assign(context, filtered);
          }
          providers.push(provider.name);

          if (this.config.logProviders) {
            workerLogger.debug(
              { provider: provider.name, keys: Object.keys(providerContext) },
              'Context provider contributed'
            );
          }
        }
      } catch (error) {
        workerLogger.warn(
          {
            provider: provider.name,
            error: serializeError(error),
          },
          'Context provider failed, skipping'
        );
      }
    }

    // Log hierarchy status for verification (plan step 5)
    if (context.hierarchy?.children && context.hierarchy.children.length > 0) {
      const completedChildren = context.hierarchy.children.filter(c => c.status === 'COMPLETED');
      workerLogger.info(
        {
          totalChildren: context.hierarchy.children.length,
          completedChildren: completedChildren.length,
          completedIds: completedChildren.map(c => ({ id: c.requestId.slice(0, 8), name: c.jobName }))
        },
        'Hierarchy status verification: completed children detected'
      );
    }

    // Phase 2: Build invariants from invariant providers (with access to context)
    const invariants: Invariant[] = [];
    for (const provider of this.invariantProviders) {
      if (!provider.enabled(this.config)) {
        if (this.config.logProviders) {
          workerLogger.debug({ provider: provider.name }, 'Invariant provider disabled, skipping');
        }
        continue;
      }

      try {
        const providerInvariants = await provider.provide(buildContext, context);
        if (providerInvariants && providerInvariants.length > 0) {
          invariants.push(...providerInvariants);
          providers.push(provider.name);

          if (this.config.logProviders) {
            workerLogger.debug(
              { provider: provider.name, count: providerInvariants.length },
              'Invariant provider contributed'
            );
          }

          // Log COORD invariants from CoordinationInvariantProvider
          if (provider.name === 'coordination') {
            const coordInvariants = providerInvariants.filter(i => i.id.startsWith('COORD-'));
            if (coordInvariants.length > 0) {
              workerLogger.info(
                {
                  coordInvariantCount: coordInvariants.length,
                  invariantIds: coordInvariants.map(i => i.id)
                },
                'COORD invariants generated for coordination'
              );
            }
          }
        }
      } catch (error) {
        workerLogger.warn(
          {
            provider: provider.name,
            error: serializeError(error),
          },
          'Invariant provider failed, skipping'
        );
      }
    }

    // Sort invariants by layer for urgency-based ordering: ACTION → JOB → PROTOCOL
    // Layer is derived from ID prefix
    const getLayerFromId = (id: string): 'action' | 'job' | 'protocol' => {
      const prefix = id.split('-')[0];
      if (['COORD', 'STATE', 'QUAL'].includes(prefix)) return 'action';
      if (['JOB', 'GOAL'].includes(prefix)) return 'job';
      return 'protocol';
    };
    const layerOrder = ['action', 'job', 'protocol'];
    invariants.sort((a, b) => layerOrder.indexOf(getLayerFromId(a.id)) - layerOrder.indexOf(getLayerFromId(b.id)));

    // Assemble the unified blueprint
    const blueprint: UnifiedBlueprint = {
      invariants,
      context,
      metadata: {
        generatedAt: new Date().toISOString(),
        requestId,
        providers,
      },
    };

    const buildTime = Date.now() - startTime;

    if (this.config.logProviders) {
      workerLogger.info(
        {
          requestId,
          invariantCount: invariants.length,
          contextKeys: Object.keys(context),
          providerCount: providers.length,
          buildTime,
        },
        'Blueprint built'
      );
    }

    return { blueprint, buildTime };
  }

  /**
   * Build and render to prose (for agent consumption)
   *
   * Returns human-readable prose with three-layer semantic grouping:
   * - IMMEDIATE: Coordination actions (COORD-*, QUAL-*, RECOV-*)
   * - MISSION: Goals and strategy (JOB-*, GOAL-*, OUT-*, STRAT-*)
   * - PROTOCOL: Operating principles (SYS-*, STATE-*, TOOL-*, CYCLE-*, LEARN-*)
   *
   * For structured data, use build() directly.
   */
  async buildPrompt(
    requestId: string,
    metadata: IpfsMetadata,
    recognition?: RecognitionPhaseResult | null
  ): Promise<string> {
    const { blueprint } = await this.build(requestId, metadata, recognition);
    const promptString = renderBlueprintToProse(blueprint);

    // Verify invariants reach agent prompt
    const coordInvariants = blueprint.invariants.filter(i => i.id.startsWith('COORD-'));
    if (coordInvariants.length > 0) {
      workerLogger.info(
        {
          requestId,
          coordInvariantCount: coordInvariants.length,
          promptLength: promptString.length,
          sample: (coordInvariants[0] as BooleanInvariant)?.condition?.slice(0, 80)
        },
        'Blueprint prompt contains COORD invariants for agent'
      );
    }

    // Log measurement context status
    const measurementCount = blueprint.context.measurements?.length ?? 0;
    if (measurementCount > 0) {
      workerLogger.info(
        {
          requestId,
          measurementCount,
          invariantIds: blueprint.context.measurements?.map(m => m.invariantId),
        },
        'Blueprint includes measurement context for agent'
      );
    }

    return promptString;
  }

  /**
   * Get the current configuration
   */
  getConfig(): BlueprintBuilderConfig {
    return { ...this.config };
  }

  /**
   * Update the configuration
   */
  updateConfig(config: Partial<BlueprintBuilderConfig>): this {
    this.config = { ...this.config, ...config };
    return this;
  }
}

/**
 * Create a BlueprintBuilder with all default providers registered
 *
 * This is the main factory function for creating a fully-configured builder.
 * Import and call this to get a ready-to-use builder with all providers.
 *
 * Provider registration order matters:
 * - Context providers run first (Phase 1), building the BlueprintContext
 * - Invariant providers run second (Phase 2), with access to the built context
 *
 * Within each phase, providers run in registration order.
 * Providers are ordered by domain priority: system → strategy → recovery → goal → etc.
 */
export function createBlueprintBuilder(
  config?: Partial<BlueprintBuilderConfig>
): BlueprintBuilder {
  const builder = new BlueprintBuilder(config);

  // Phase 1: Context providers (build BlueprintContext)
  builder.registerContextProvider(new JobContextProvider());
  builder.registerContextProvider(new ProgressCheckpointProvider());
  builder.registerContextProvider(new MeasurementContextProvider());
  builder.registerContextProvider(VentureContextProvider);

  // Phase 2: Invariant providers (have access to built context)
  // Order follows domain priority: system → strategy → recovery → goal → learning → coordination → state → tooling → quality
  builder.registerInvariantProvider(new SystemInvariantProvider());
  builder.registerInvariantProvider(new OutputInvariantProvider());  // Output schema from outputSpec
  builder.registerInvariantProvider(new StrategyInvariantProvider());
  builder.registerInvariantProvider(new RecoveryInvariantProvider());
  builder.registerInvariantProvider(new GoalInvariantProvider());
  builder.registerInvariantProvider(new LearningInvariantProvider());
  builder.registerInvariantProvider(new CoordinationInvariantProvider());
  builder.registerInvariantProvider(new StateInvariantProvider());
  builder.registerInvariantProvider(new ToolingInvariantProvider());
  builder.registerInvariantProvider(new QualityInvariantProvider());
  builder.registerInvariantProvider(new CycleInvariantProvider());

  return builder;
}
