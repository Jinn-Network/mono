/**
 * Layer 1 envelope check: schema conformance.
 *
 * Scope: docs/superpowers/specs/2026-04-23-jinn-execution-envelope-tee-scope.md §4.10.
 *
 * Validates the full envelope against `SignedEnvelopeSchema`. Runs at every
 * evidence tier — it is the first structural gate.
 */

import { SignedEnvelopeSchema } from '../../types/envelope.js';
import type { CheckResult, ConformanceContext } from '../types.js';

/**
 * Check id: `envelope.schema`
 * Layer: 1
 *
 * Runs `SignedEnvelopeSchema.safeParse(ctx.envelope)`. Returns pass if valid,
 * fail with a human-readable Zod issue summary on error.
 */
export function checkEnvelopeSchema(ctx: ConformanceContext): CheckResult {
  const id = 'envelope.schema';
  const layer = 1 as const;

  if (!ctx.envelope) {
    return { id, layer, passed: false, detail: 'envelope not loaded' };
  }

  const result = SignedEnvelopeSchema.safeParse(ctx.envelope);
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
