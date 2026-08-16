import { SessionDerivedTaskSchema } from '@jinn-network/sdk';
import type { SolverTypeDefinition } from './solver-type.js';

export const sessionDerived: SolverTypeDefinition = {
  solverType: 'session-derived.v1',
  async parseSpec(raw) {
    const spec = SessionDerivedTaskSchema.parse(raw);
    const now = Math.floor(Date.now() / 1000);
    return {
      window: { startTs: now, endTs: now + 4 * 60 * 60 },
      claimPolicy: {
        mode: 'parallel',
        maxClaims: 50,
        maxClaimsPerOperator: 5,
        claimLeaseTtlSeconds: 4 * 60 * 60,
      },
      spec,
      eligibility: { sourceCaptureCid: spec.sourceCaptureCid },
    };
  },
  ui: {
    category: 'coding',
    description: 'Tasks distilled from operator-approved local agent session captures.',
  },
};
