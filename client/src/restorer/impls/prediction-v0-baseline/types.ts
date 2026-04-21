export interface StrategyPrediction {
  probability: string;    // decimal string ∈ [0,1]
  modelId: string;
}

export interface Strategy {
  predict(intent: import('../../../types/prediction.js').PredictionV0Intent, currentPrice: string): StrategyPrediction;
}
