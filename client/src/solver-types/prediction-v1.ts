import { PredictionV1TaskSchema } from '../types/prediction-v1.js';
import type { SolverTypeDefinition } from './solver-type.js';

/**
 * SolverType definition for prediction.v1 — Polymarket probability forecasting.
 *
 * Per Task 22 of spec/2026-05-05-solvernet-creation-and-launch.md, the
 * config-block-keyed auto-task generator (`buildGenerator` +
 * `getTestnetAutoConfig`) was retired. Generator construction lives at
 * `makePredictionV1GeneratorForLaunchedRecord` in `./prediction-v1-auto.ts`
 * and is driven by launched-record ownership, not by SolverType registration.
 */
export const predictionV1: SolverTypeDefinition = {
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
  ui: {
    description: 'Prediction-market probability forecasting (Polymarket)',
    category: 'prediction',
  },
};
