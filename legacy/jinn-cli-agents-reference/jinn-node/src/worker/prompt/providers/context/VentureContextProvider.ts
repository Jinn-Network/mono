/**
 * VentureContextProvider - Injects venture-level context into workstream prompts.
 *
 * When a workstream has `ventureContext` in its additionalContext (set by the
 * venture watcher during dispatch), this provider:
 * 1. Extracts venture invariants (FLOOR/CEILING/RANGE homeostatic goals)
 * 2. Formats them as context alongside last measurements
 * 3. Returns them in the BlueprintContext for the agent to reference
 *
 * This allows workstream agents to see the venture's higher-level goals
 * without being directly responsible for measuring them.
 */

import { workerLogger } from '../../../../logging/index.js';
import type {
  ContextProvider,
  BuildContext,
  BlueprintContext,
  BlueprintBuilderConfig,
  MeasurementInfo,
  VentureInvariant,
} from '../../types.js';

export const VentureContextProvider: ContextProvider = {
  name: 'VentureContextProvider',

  enabled: (_config: BlueprintBuilderConfig) => true,

  async provide(ctx: BuildContext): Promise<Partial<BlueprintContext>> {
    const additionalContext = ctx.metadata?.additionalContext as any;
    const ventureContext = additionalContext?.ventureContext;

    if (!ventureContext) {
      return {};
    }

    const { ventureId, ventureName, ventureInvariants, lastMeasurements } = ventureContext;

    if (!Array.isArray(ventureInvariants) || ventureInvariants.length === 0) {
      return {};
    }

    workerLogger.debug(
      { ventureId, ventureName, invariantCount: ventureInvariants.length },
      'VentureContextProvider: injecting venture context'
    );

    // Convert last measurements into MeasurementInfo format
    const measurements: MeasurementInfo[] = [];
    if (Array.isArray(lastMeasurements)) {
      for (const m of lastMeasurements) {
        measurements.push({
          invariantId: m.invariantId,
          type: m.type || 'FLOOR',
          value: m.value,
          passed: m.passed,
          context: m.context,
          timestamp: m.measuredAt || m.timestamp,
        });
      }
    }

    const result: Partial<BlueprintContext> = {};

    // Only include measurements if we actually have them — avoids overwriting
    // MeasurementContextProvider output with undefined via Object.assign
    if (measurements.length > 0) {
      result.measurements = measurements;
    }

    // Inject venture invariants so agents see the venture's homeostatic goals
    result.ventureInvariants = ventureInvariants as VentureInvariant[];

    return result;
  },
};
