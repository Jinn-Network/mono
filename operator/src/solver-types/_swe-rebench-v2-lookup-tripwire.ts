/**
 * Lookup tripwire — flags suspiciously-fast solves and byte-identical upstream patches.
 * Spec §5.4, PR 2.3.
 */

export interface LookupTripwireInput {
  solveDurationMs: number;
  deliveredPatch: string;
  upstreamPatch?: string;
  /** Default 5s — below this is suspicious for SWE-rebench instances. */
  minDurationMs?: number;
}

export interface LookupTripwireResult {
  flagged: boolean;
  reasons: string[];
}

export function evaluateLookupTripwire(input: LookupTripwireInput): LookupTripwireResult {
  const reasons: string[] = [];
  const minMs = input.minDurationMs ?? 5_000;
  if (input.solveDurationMs < minMs) {
    reasons.push(`solve-duration-below-${minMs}ms`);
  }
  if (
    input.upstreamPatch != null &&
    input.upstreamPatch.length > 0 &&
    input.deliveredPatch === input.upstreamPatch
  ) {
    reasons.push('patch-byte-identical-to-upstream');
  }
  return { flagged: reasons.length > 0, reasons };
}
