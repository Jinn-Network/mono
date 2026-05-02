import { resolvePredictionApyV0Template } from './prediction-apy-v0-template.js';
import {
  makePredictionApyV0Generator,
  type PredictionApyV0AutoConfig,
} from './prediction-apy-v0-auto.js';
import type { SolverTypeDefinition } from './solver-type.js';

export const predictionApyV0: SolverTypeDefinition<PredictionApyV0AutoConfig | undefined> = {
  solverType: 'prediction.apy.v0',
  async parseSpec(raw) {
    const task = await resolvePredictionApyV0Template(raw);
    return { window: task.window, spec: task.spec, eligibility: task.eligibility };
  },
  buildGenerator: (config) => makePredictionApyV0Generator(config ?? {}),
  getTestnetAutoConfig: (ctx) => {
    if (ctx.network !== 'testnet' || ctx.env['JINN_ENABLE_APY_AUTO_TASKS'] !== '1') {
      return undefined;
    }
    return {
      agentEoa: ctx.agentEoa,
      safeAddress: ctx.safeAddress,
      agentPrivateKey: ctx.agentPrivateKey,
    };
  },
  ui: {
    description: 'Supply APY prediction (Aave v3 TWA)',
    category: 'prediction',
  },
};
