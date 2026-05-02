import type { PredictionApyV0Task } from '../../../types/prediction-apy.js';

/**
 * Shell for future metric kinds: today `twApyBps` is already integer-rounded
 * from the Aave client; this keeps a single hook if we add more `metric.type`s.
 */
export function deriveGroundTruthBps(task: PredictionApyV0Task, twApyBps: number): string {
  if (task.spec.metric.type !== 'supply-apy-twa-bps') {
    throw new Error(`unsupported metric: ${task.spec.metric.type}`);
  }
  return String(Math.round(twApyBps));
}
