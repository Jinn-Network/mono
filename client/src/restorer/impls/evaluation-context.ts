import type { RestorationJob } from '../../types/desired-state.js';

/** Eval `RestorationJob.context` key for the restoration job's intended-state IPFS CID (not the eval job's). */
export const RESTORATION_INTENT_CID_CONTEXT_KEY = 'restorationIntentCid' as const;

/**
 * Eval `RestorationJob.context` key for the restoration envelope's IPFS CID.
 * Set by the daemon when creating evaluation jobs so evaluators can populate the
 * `restorationEnvelope.cid` back-reference in the verdict payload without a
 * synchronous IPFS round-trip at verdict time.
 */
export const RESTORATION_ENVELOPE_CID_CONTEXT_KEY = 'restorationEnvelopeCid' as const;

/**
 * Resolve the expected restoration intent CID for `integrity.intent_ref`.
 * Test-only overrides win; otherwise the value must be present in `context`.
 * There is no fallback to the evaluation job's `intentCid` (wrong reference).
 */
export function resolveExpectedRestorationIntentCid(
  intent: RestorationJob,
  testDeps?: { expectedIntentCid?: string },
): { kind: 'resolved'; cid: string } | { kind: 'missing' } {
  if (testDeps?.expectedIntentCid) {
    return { kind: 'resolved', cid: testDeps.expectedIntentCid };
  }
  const v = intent.context?.[RESTORATION_INTENT_CID_CONTEXT_KEY];
  if (typeof v === 'string' && v.length > 0) {
    return { kind: 'resolved', cid: v };
  }
  return { kind: 'missing' };
}
