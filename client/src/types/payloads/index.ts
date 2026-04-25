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
  PredictionApyV0RestorationPayloadSchema,
  PredictionApyV0VerdictPayloadSchema,
} from './prediction-apy-v0.js';
import type { Role } from '../envelope.js';

/**
 * Passthrough payload schema for legacy / untyped intents.
 * Accepts any object — no structural validation.
 */
const LegacyPassthroughSchema = z.record(z.unknown());

/**
 * Registry mapping (kind, role) → payload schema.
 * Update when adding a new kind.
 */
export const KIND_PAYLOADS: Record<string, Record<Role, z.ZodSchema>> = {
  'portfolio.v0': {
    restoration: PortfolioV0RestorationPayloadSchema,
    verdict: PortfolioV0VerdictPayloadSchema,
  },
  'prediction.v0': {
    restoration: PredictionV0RestorationPayloadSchema,
    verdict: PredictionV0VerdictPayloadSchema,
  },
  'prediction.apy.v0': {
    restoration: PredictionApyV0RestorationPayloadSchema,
    verdict: PredictionApyV0VerdictPayloadSchema,
  },
  // Passthrough kind for legacy / untyped intents (no spec.kind).
  // Produced by the legacy-claude impl; no structural validation on payload.
  'legacy.v0': {
    restoration: LegacyPassthroughSchema,
    verdict: LegacyPassthroughSchema,
  },
};

export function validatePayload(kind: string, role: Role, payload: unknown): void {
  const bucket = KIND_PAYLOADS[kind];
  if (!bucket) throw new Error(`Unknown kind: ${kind}`);
  const schema = bucket[role];
  if (!schema) throw new Error(`No payload schema for (${kind}, ${role})`);
  schema.parse(payload);
}

export * from './portfolio-v0.js';
export * from './prediction-v0.js';
export * from './prediction-apy-v0.js';
