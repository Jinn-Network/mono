import type { PredictionApyV0Intent } from '../../../types/prediction-apy.js';

export function deriveGroundTruthBps(intent: PredictionApyV0Intent, twApyBps: number): string {
  if (intent.spec.metric.type !== 'supply-apy-twa-bps') {
    throw new Error(`unsupported metric: ${intent.spec.metric.type}`);
  }
  return String(Math.round(twApyBps));
}
