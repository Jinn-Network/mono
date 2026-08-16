/**
 * Layer 1 trajectory check: schema conformance.
 *
 * Scope: docs/superpowers/specs/2026-04-23-jinn-execution-envelope-tee-scope.md
 * §3.1 trajectory row + K6 span profile.
 *
 * Validates the trajectory against JinnTrajectoryV1Schema. Skipped when
 * envelope.trajectory is null (legitimate at self-signed / committed tier
 * during V1 rollout).
 */

import { JinnTrajectoryV1Schema } from '../../trajectory/schema.js';
import type { CheckResult, ConformanceContext } from '../types.js';

/**
 * Check id: `trajectory.schema`
 * Layer: 1
 *
 * If ctx.envelope.trajectory is null (no trajectory in envelope) AND
 * ctx.trajectory is falsy, return a SKIP. Otherwise validate against
 * JinnTrajectoryV1Schema.
 */
export function checkTrajectorySchema(ctx: ConformanceContext): CheckResult {
  const id = 'trajectory.schema';
  const layer = 1 as const;

  // Skip when envelope explicitly carries null trajectory (no trajectory in run).
  if (ctx.envelope?.trajectory == null && ctx.trajectory == null) {
    return { id, layer, passed: true, skipped: true, detail: 'envelope.trajectory is null' };
  }

  const result = JinnTrajectoryV1Schema.safeParse(ctx.trajectory);
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
