import type { PredictionApyV0Intent } from '../../../types/prediction-apy.js';

/**
 * Shell for future metric kinds: today `twApyBps` is already integer-rounded
 * from the Aave client; this keeps a single hook if we add more `metric.type`s.
 */
export function deriveGroundTruthBps(intent: PredictionApyV0Intent, twApyBps: number): string {
  if (intent.spec.metric.type !== 'supply-apy-twa-bps') {
    throw new Error(`unsupported metric: ${intent.spec.metric.type}`);
  }
  return String(Math.round(twApyBps));
}
