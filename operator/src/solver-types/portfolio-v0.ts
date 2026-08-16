import { PortfolioV0TaskSchema } from '../types/portfolio.js';
import type { SolverTypeDefinition } from './solver-type.js';

export const portfolioV0: SolverTypeDefinition = {
  solverType: 'portfolio.v0',
  async parseSpec(raw) {
    const task = PortfolioV0TaskSchema.parse(raw);
    return { window: task.window, spec: task.spec, eligibility: task.eligibility };
  },
  ui: {
    description: 'Portfolio trading task (Hyperliquid)',
    category: 'portfolio',
  },
};
