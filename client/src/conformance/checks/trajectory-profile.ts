/**
 * Layer 1 trajectory check: span profile conformance.
 *
 * Scope: docs/superpowers/specs/2026-04-23-jinn-execution-envelope-tee-scope.md §3.1 K6.
 *
 * For every span in the trajectory, verifies that the required attributes
 * declared in SPAN_PROFILE[jinn.span.kind] are present. Unknown span kinds
 * fail immediately. Reports up to 5 failures to bound message length.
 *
 * Skipped when trajectory is absent.
 */

import type { Span } from '../../trajectory/schema.js';
import { SPAN_PROFILE, validateSpanProfile } from '../../trajectory/span-profile.js';
import type { CheckResult, ConformanceContext } from '../types.js';

type TrajLike = { spans: Span[] };

/**
 * Check id: `trajectory.span-profile`
 * Layer: 1
 */
export function checkSpanProfile(ctx: ConformanceContext): CheckResult {
  const id = 'trajectory.span-profile';
  const layer = 1 as const;

  const traj = ctx.trajectory as TrajLike | null | undefined;
  if (!traj) return { id, layer, passed: true, skipped: true };

  const failures: string[] = [];

  for (let i = 0; i < traj.spans.length; i++) {
    const span = traj.spans[i];
    const kind = span.attributes['jinn.span.kind'] as string | undefined;

    if (!kind) {
      failures.push(`span[${i}] (${span.spanId}) missing jinn.span.kind`);
      continue;
    }

    // Unknown kind check (SPAN_PROFILE only has normative kinds)
    if (!(kind in SPAN_PROFILE)) {
      failures.push(`span[${i}] (${span.spanId}) unknown jinn.span.kind: ${kind}`);
      continue;
    }

    const result = validateSpanProfile(span);
    if (!result.valid) {
      const missingList = result.missing.join(', ');
      failures.push(
        `span[${i}] (${span.spanId}) kind=${kind} missing required attributes: ${missingList}`,
      );
    }
  }

  if (failures.length === 0) return { id, layer, passed: true };

  return {
    id,
    layer,
    passed: false,
    detail: failures.slice(0, 5).join('; '),
  };
}
