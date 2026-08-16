import { z } from 'zod/v3';
import {
  PortfolioV0RestorationPayloadSchema,
  PortfolioV0VerdictPayloadSchema,
} from './portfolio-v0.js';
import {
  PredictionV0RestorationPayloadSchema,
  PredictionV0VerdictPayloadSchema,
} from './prediction-v0.js';
import {
  PredictionV1RestorationPayloadSchema,
  PredictionV1VerdictPayloadSchema,
} from './prediction-v1.js';
import {
  PredictionApyV0RestorationPayloadSchema,
  PredictionApyV0VerdictPayloadSchema,
} from './prediction-apy-v0.js';
import {
  SweRebenchV2SolutionPayloadSchema,
  SweRebenchV2VerdictPayloadSchema,
} from '@jinn-network/sdk/solvernets/swe-rebench-v2';
import {
  JinnRepoSolutionPayloadSchema,
  JinnRepoVerdictPayloadSchema,
} from '@jinn-network/sdk/solvernets/jinn-repo';
import { normalizeEnvelopeRole, type LegacyEnvelopeRole, type Role } from '../envelope.js';

/**
 * Passthrough payload schema for legacy / untyped tasks.
 * Accepts any object — no structural validation.
 */
const LegacyPassthroughSchema = z.record(z.unknown());

/**
 * Registry mapping (solverType, role) → payload schema.
 * Update when adding a new solverType.
 */
export const SOLVER_TYPE_PAYLOADS: Record<string, Partial<Record<Role, z.ZodSchema>>> = {
  'portfolio.v0': {
    solution: PortfolioV0RestorationPayloadSchema,
    verdict: PortfolioV0VerdictPayloadSchema,
  },
  'prediction.v0': {
    solution: PredictionV0RestorationPayloadSchema,
    verdict: PredictionV0VerdictPayloadSchema,
  },
  'prediction.v1': {
    solution: PredictionV1RestorationPayloadSchema,
    verdict: PredictionV1VerdictPayloadSchema,
  },
  'prediction.apy.v0': {
    solution: PredictionApyV0RestorationPayloadSchema,
    verdict: PredictionApyV0VerdictPayloadSchema,
  },
  // SWE-rebench v2 SolverNet. The task role is still restoration/evaluation,
  // but execution envelopes use solution/verdict.
  'swe-rebench-v2.v1': {
    solution: SweRebenchV2SolutionPayloadSchema,
    verdict: SweRebenchV2VerdictPayloadSchema,
  },
  // jinn-repo SolverNet — real merged Jinn-Network/mono PRs.
  'jinn-repo.v1': {
    solution: JinnRepoSolutionPayloadSchema,
    verdict: JinnRepoVerdictPayloadSchema,
  },
  // Passthrough SolverType for legacy / untyped tasks.
  // Produced by the legacy-claude impl; no structural validation on payload.
  'legacy.v0': {
    solution: LegacyPassthroughSchema,
    verdict: LegacyPassthroughSchema,
  },
};

export function validatePayload(solverType: string, role: Role | LegacyEnvelopeRole, payload: unknown): void {
  const normalizedRole = normalizeEnvelopeRole(role);
  if (normalizedRole === 'capture') return;  // capture payloads are free-form; no structural validation in v0
  const bucket = SOLVER_TYPE_PAYLOADS[solverType];
  if (!bucket) throw new Error(`Unknown solverType: ${solverType}`);
  const schema = bucket[normalizedRole];
  if (!schema) throw new Error(`No payload schema for (${solverType}, ${normalizedRole})`);
  schema.parse(payload);
}

export * from './portfolio-v0.js';
export * from './prediction-v0.js';
export * from './prediction-v1.js';
export * from './prediction-apy-v0.js';
