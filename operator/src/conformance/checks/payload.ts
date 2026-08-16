/**
 * Layer 1 envelope check: payload validity.
 *
 * Scope: docs/superpowers/specs/2026-04-23-jinn-execution-envelope-tee-scope.md §4.10.
 *
 * Validates the envelope payload against the SOLVER_TYPE_PAYLOADS registry.
 * The payload must conform to the schema registered for the (solverType, role)
 * pair in the payload registry.
 */

import { SOLVER_TYPE_PAYLOADS } from '../../types/payloads/index.js';
import { normalizeEnvelopeRole } from '../../types/envelope.js';
import type { CheckResult, ConformanceContext } from '../types.js';

/**
 * Check id: `envelope.payload`
 * Layer: 1
 *
 * Uses `SOLVER_TYPE_PAYLOADS[solverType][role].safeParse(envelope.payload)`.
 * Returns pass if valid, fail with a human-readable issue summary on error.
 * Fails immediately if solverType is not in the registry or role has no schema.
 */
export function checkPayload(ctx: ConformanceContext): CheckResult {
  const id = 'envelope.payload';
  const layer = 1 as const;

  if (!ctx.envelope) {
    return { id, layer, passed: false, detail: 'envelope not loaded' };
  }

  const env = ctx.envelope;
  const bucket = SOLVER_TYPE_PAYLOADS[env.solverType];
  if (!bucket) {
    return { id, layer, passed: false, detail: `unknown solverType: ${env.solverType}` };
  }

  const role = normalizeEnvelopeRole(env.role);
  const schema = bucket[role];
  if (!schema) {
    return {
      id,
      layer,
      passed: false,
      detail: `no payload schema for (${env.solverType}, ${role})`,
    };
  }

  const result = schema.safeParse(env.payload);
  if (result.success) {
    return { id, layer, passed: true };
  }

  return {
    id,
    layer,
    passed: false,
    detail: result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; '),
  };
}
