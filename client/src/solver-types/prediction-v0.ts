import { BASE_SEPOLIA_FEEDS } from '../venues/chainlink/feeds.js';
import {
  predictionV1TemplateNeedsReadCurrent,
  resolvePredictionV1Template,
} from './prediction-v0-template.js';
import { makePredictionV1Generator, type PredictionV1AutoConfig } from './prediction-v0-auto.js';
import type { SolverTypeDefinition } from './solver-type.js';
import { PREDICTION_V1_KIND } from './constants.js';

export const legacyChainlinkPredictionV1: SolverTypeDefinition<PredictionV1AutoConfig> = {
  solverType: PREDICTION_V1_KIND,
  async parseSpec(raw, deps) {
    if (predictionV1TemplateNeedsReadCurrent(raw) && !deps?.readCurrent) {
      throw new Error(
        'prediction.v1 parseSpec requires readCurrent (Chainlink) when the template uses a current[±…] threshold sentinel',
      );
    }
    const task = await resolvePredictionV1Template(raw, {
      readCurrent: deps?.readCurrent,
    });
    return { window: task.window, spec: task.spec, eligibility: task.eligibility };
  },
  buildGenerator: (config) => makePredictionV1Generator(config),
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
      windowDurationMs: ctx.predictionV1WindowMs,
      resolveGapMs: ctx.predictionV1ResolveGapMs,
    };
  },
  ui: {
    description: 'Price threshold prediction (Chainlink oracle)',
    category: 'prediction',
  },
};
