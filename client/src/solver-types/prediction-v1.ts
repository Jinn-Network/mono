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
    if (ctx.network !== 'testnet' || !ctx.predictionV1LauncherEnabled) return undefined;
    return {
      agentEoa: ctx.agentEoa,
      safeAddress: ctx.safeAddress,
      agentPrivateKey: ctx.agentPrivateKey,
      submissionWindowMs: ctx.predictionV1WindowMs ?? nonNegativeNumberEnv(ctx.env, 'JINN_PREDICTION_V1_WINDOW_MS'),
      cadenceMs: ctx.predictionV1CadenceMs ?? nonNegativeNumberEnv(ctx.env, 'JINN_PREDICTION_V1_CADENCE_MS'),
      maxNewRoundsPerPoll: ctx.predictionV1MaxNewRoundsPerPoll ?? nonNegativeNumberEnv(ctx.env, 'JINN_PREDICTION_V1_MAX_NEW_ROUNDS_PER_POLL'),
      maxNewRoundsPerDay: ctx.predictionV1MaxNewRoundsPerDay ?? nonNegativeNumberEnv(ctx.env, 'JINN_PREDICTION_V1_MAX_NEW_ROUNDS_PER_DAY'),
      maxOpenRounds: ctx.predictionV1MaxOpenRounds ?? nonNegativeNumberEnv(ctx.env, 'JINN_PREDICTION_V1_MAX_OPEN_ROUNDS'),
      allowlistConditionIds: ctx.predictionV1AllowlistConditionIds ?? csvEnv(ctx.env, 'JINN_PREDICTION_V1_ALLOWLIST_CONDITION_IDS'),
      blocklistConditionIds: ctx.predictionV1BlocklistConditionIds ?? csvEnv(ctx.env, 'JINN_PREDICTION_V1_BLOCKLIST_CONDITION_IDS'),
    };
  },
  ui: {
    description: 'Prediction-market probability forecasting (Polymarket)',
    category: 'prediction',
  },
};

function nonNegativeNumberEnv(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const value = env[name]?.trim();
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function csvEnv(env: NodeJS.ProcessEnv, name: string): string[] | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}
