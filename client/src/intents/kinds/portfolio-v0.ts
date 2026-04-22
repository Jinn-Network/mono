import { PortfolioV0IntentSchema } from '../../types/portfolio.js';
import type { SpecKind } from './spec-kind.js';

export const portfolioV0: SpecKind = {
  kind: 'portfolio.v0',
  async parseSpec(raw) {
    const intent = PortfolioV0IntentSchema.parse(raw);
    return { window: intent.window, spec: intent.spec, eligibility: intent.eligibility };
  },
  ui: {
    description: 'Portfolio trading intent (Hyperliquid)',
    category: 'portfolio',
  },
};
