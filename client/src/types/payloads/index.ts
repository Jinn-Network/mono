import { z } from 'zod';
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
import type { Role } from '../envelope.js';

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
    restoration: PortfolioV0RestorationPayloadSchema,
    verdict: PortfolioV0VerdictPayloadSchema,
  },
  'prediction.v0': {
    restoration: PredictionV0RestorationPayloadSchema,
    verdict: PredictionV0VerdictPayloadSchema,
  },
  'prediction.v1': {
    restoration: PredictionV1RestorationPayloadSchema,
    verdict: PredictionV1VerdictPayloadSchema,
  },
  'prediction.apy.v0': {
    restoration: PredictionApyV0RestorationPayloadSchema,
    verdict: PredictionApyV0VerdictPayloadSchema,
  },
  // SWE-rebench v2 SolverNet. Solution maps to the `restoration` role,
  // Verdict to the `verdict` role; the SolverNet's "solving" / "evaluating"
  // role labels are surface-level synonyms in the daemon's two-role model.
  'swe-rebench-v2.v1': {
    restoration: SweRebenchV2SolutionPayloadSchema,
    verdict: SweRebenchV2VerdictPayloadSchema,
  },
  // Passthrough SolverType for legacy / untyped tasks.
  // Produced by the legacy-claude impl; no structural validation on payload.
  'legacy.v0': {
    restoration: LegacyPassthroughSchema,
    verdict: LegacyPassthroughSchema,
  },
};

export function validatePayload(solverType: string, role: Role, payload: unknown): void {
  const bucket = SOLVER_TYPE_PAYLOADS[solverType];
  if (!bucket) throw new Error(`Unknown solverType: ${solverType}`);
  const schema = bucket[role];
  if (!schema) throw new Error(`No payload schema for (${solverType}, ${role})`);
  schema.parse(payload);
}

export * from './portfolio-v0.js';
export * from './prediction-v0.js';
export * from './prediction-v1.js';
export * from './prediction-apy-v0.js';
