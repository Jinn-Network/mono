// The reverse-DNS type strings are the single source of truth for the discriminated observation
// payload schema (schemas/observation.ts) and are re-exported here under the frozen §22 names.
import {
  ATTEMPT_OBSERVATION_TYPES,
  OBSERVATION_TYPES,
  SUBMISSION_OBSERVATION_TYPES,
} from "./schemas/observation.js";

export const SUBMISSION_EVENT_TYPES = SUBMISSION_OBSERVATION_TYPES;
export const ATTEMPT_EVENT_TYPES = ATTEMPT_OBSERVATION_TYPES;
export const TASK_EXECUTION_EVENT_TYPES = OBSERVATION_TYPES;

/** Highest representable value under the fixed-width 16-digit `sequence` encoding (§10.1). */
export const MAX_SEQUENCE = 9999999999999999n;

/**
 * Fixed-width, zero-padded 16-digit decimal encoding of the CloudEvents `sequence` extension
 * (§10.1) — orders lexicographically, which is what CloudEvents' `sequence` mandates.
 */
export function formatSequence(n: bigint): string {
  if (n < 0n || n > MAX_SEQUENCE) {
    throw new RangeError(`sequence out of the 16-digit range: ${n}`);
  }
  return n.toString().padStart(16, "0");
}
