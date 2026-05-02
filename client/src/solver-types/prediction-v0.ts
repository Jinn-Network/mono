import { BASE_SEPOLIA_FEEDS } from '../venues/chainlink/feeds.js';
import {
  predictionV0TemplateNeedsReadCurrent,
  resolvePredictionV0Template,
} from './prediction-v0-template.js';
import { makePredictionV0Generator, type PredictionV0AutoConfig } from './prediction-v0-auto.js';
import type { SolverTypeDefinition } from './solver-type.js';
import { PREDICTION_V0_KIND } from './constants.js';

export const predictionV0: SolverTypeDefinition<PredictionV0AutoConfig> = {
  solverType: PREDICTION_V0_KIND,
  async parseSpec(raw, deps) {
    if (predictionV0TemplateNeedsReadCurrent(raw) && !deps?.readCurrent) {
      throw new Error(
        'prediction.v0 parseSpec requires readCurrent (Chainlink) when the template uses a current[±…] threshold sentinel',
      );
    }
    const task = await resolvePredictionV0Template(raw, {
      readCurrent: deps?.readCurrent,
    });
    return { window: task.window, spec: task.spec, eligibility: task.eligibility };
  },
  buildGenerator: (config) => makePredictionV0Generator(config),
  getTestnetAutoConfig: (ctx) => {
    if (ctx.network !== 'testnet') return undefined;
    return {
      feed: BASE_SEPOLIA_FEEDS['ETH / USD'],
      feedDescription: 'ETH / USD',
      venue: 'chainlink-base-sepolia',
      rpcUrl: ctx.rpcUrl,
      agentEoa: ctx.agentEoa,
      safeAddress: ctx.safeAddress,
      agentPrivateKey: ctx.agentPrivateKey,
      windowDurationMs: ctx.predictionV0WindowMs,
      resolveGapMs: ctx.predictionV0ResolveGapMs,
    };
  },
  ui: {
    description: 'Price threshold prediction (Chainlink oracle)',
    category: 'prediction',
  },
};
