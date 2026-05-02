/**
 * Layer 1 trajectory check: hash-chain integrity.
 *
 * Scope: docs/superpowers/specs/2026-04-23-jinn-execution-envelope-tee-scope.md
 * §3.1 trajectory-signing-granularity row.
 *
 * Walks every span in order:
 *   - span[0].jinn.prevSpanHash must equal computeGenesisHash(envelope.task.cid)
 *   - span[n].jinn.prevSpanHash must equal computePrevSpanHash(span[n-1])
 *
 * Skipped when trajectory is absent.
 */

import type { Span } from '../../trajectory/schema.js';
import { computeGenesisHash, computePrevSpanHash } from '../../trajectory/hash-chain.js';
import type { CheckResult, ConformanceContext } from '../types.js';

type TrajLike = { spans: Span[] };

/**
 * Check id: `trajectory.hash-chain`
 * Layer: 1
 */
export function checkHashChainIntegrity(ctx: ConformanceContext): CheckResult {
  const id = 'trajectory.hash-chain';
  const layer = 1 as const;

  const traj = ctx.trajectory as TrajLike | null | undefined;
  if (!traj) return { id, layer, passed: true, skipped: true };

  const taskCid = (ctx.envelope as { task?: { cid?: string } } | undefined)?.task?.cid;
  if (!taskCid) {
    return {
      id,
      layer,
      passed: false,
      detail: 'envelope.task.cid missing; cannot compute genesis hash',
    };
  }

  const genesis = computeGenesisHash(taskCid);
  let expectedPrev: string = genesis;

  for (let i = 0; i < traj.spans.length; i++) {
    const span = traj.spans[i];
    const declared = span.attributes['jinn.prevSpanHash'] as string | undefined;

    if (
      typeof declared !== 'string' ||
      declared.toLowerCase() !== expectedPrev.toLowerCase()
    ) {
      return {
        id,
        layer,
        passed: false,
        detail: `span[${i}] (${span.spanId}): prevSpanHash ${declared} !== expected ${expectedPrev}${i === 0 ? ' (genesis)' : ''}`,
      };
    }

    expectedPrev = computePrevSpanHash(span);
  }

  return { id, layer, passed: true };
}
