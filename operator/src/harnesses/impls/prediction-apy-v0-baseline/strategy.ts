import type { StrategyPrediction } from './types.js';

export function persistencePredict(twApyBps: number): StrategyPrediction {
  return {
    predictedBps: String(Math.round(twApyBps)),
    modelId: 'apy-persistence.v1',
  };
}
