import type { DesiredState } from '../../types/desired-state.js';

/** Eval `DesiredState.context` key for the restoration job’s intended-state IPFS CID (not the eval job’s). */
export const RESTORATION_INTENT_CID_CONTEXT_KEY = 'restorationIntentCid' as const;

/**
 * Resolve the expected restoration intent CID for `integrity.intent_ref`.
 * Test-only overrides win; otherwise the value must be present in `context`.
 * There is no fallback to the evaluation job’s `intentCid` (wrong reference).
 */
export function resolveExpectedRestorationIntentCid(
  intent: DesiredState,
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
