import { PredictionV1TaskSchema } from '../types/prediction-v1.js';
import {
  makePredictionV1Generator,
  type PredictionV1AutoConfig,
} from './prediction-v1-auto.js';
import type { SolverTypeDefinition } from './solver-type.js';

export const predictionV1: SolverTypeDefinition<PredictionV1AutoConfig> = {
  solverType: 'prediction.v1',
  async parseSpec(raw) {
    const task = PredictionV1TaskSchema.parse(raw);
    return {
      window: task.window,
      claimPolicy: task.claimPolicy,
      spec: task.spec,
      eligibility: task.eligibility,
    };
  },
  buildGenerator: (config) => makePredictionV1Generator(config),
  getTestnetAutoConfig: (ctx) => {
    if (ctx.network !== 'testnet') return undefined;
    return {
      agentEoa: ctx.agentEoa,
      safeAddress: ctx.safeAddress,
      agentPrivateKey: ctx.agentPrivateKey,
    };
  },
  ui: {
    description: 'Prediction-market probability forecasting (Polymarket)',
    category: 'prediction',
  },
};
