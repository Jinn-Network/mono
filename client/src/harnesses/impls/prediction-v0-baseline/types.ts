export interface StrategyPrediction {
  probability: string;    // decimal string ∈ [0,1]
  modelId: string;
}

export interface Strategy {
  predict(task: import('../../../types/prediction.js').PredictionV0Task, currentPrice: string): StrategyPrediction;
}
