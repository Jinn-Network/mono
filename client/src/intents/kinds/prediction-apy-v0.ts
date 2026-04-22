import { resolvePredictionApyV0Template } from '../prediction-apy-v0-template.js';
import {
  makePredictionApyV0Generator,
  type PredictionApyV0AutoConfig,
} from '../prediction-apy-v0-auto.js';
import type { SpecKind } from './spec-kind.js';

export const predictionApyV0: SpecKind<PredictionApyV0AutoConfig | undefined> = {
  kind: 'prediction.apy.v0',
  async parseSpec(raw) {
    const intent = await resolvePredictionApyV0Template(raw);
    return { window: intent.window, spec: intent.spec, eligibility: intent.eligibility };
  },
  buildGenerator: (config) => makePredictionApyV0Generator(config ?? {}),
  getTestnetAutoConfig: (ctx) => {
    if (ctx.network !== 'testnet' || ctx.env['JINN_ENABLE_APY_AUTO_INTENTS'] !== '1') {
      return undefined;
    }
    return {};
  },
  ui: {
    description: 'Supply APY prediction (Aave v3 TWA)',
    category: 'prediction',
  },
};
