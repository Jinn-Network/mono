import type { Attributes, RedactionRecord, ScrubResult, ScrubStage } from './types.js';

export interface KeyPolicy {
  /** keys whose values are structural and safe to publish raw */
  safe: string[];
  /** keys to delete entirely (never published) */
  drop: string[];
}

export type KeyClass = 'safe' | 'content' | 'drop';

const VERSION = '0.1.0';

/** Exact match, or prefix match when the pattern ends with `*`. */
function matches(key: string, pattern: string): boolean {
  if (pattern.endsWith('*')) return key.startsWith(pattern.slice(0, -1));
  return key === pattern;
}

/**
 * Classify an attribute key against the policy. `drop` wins over `safe` (a key
 * matching both is dropped — fail safe). Unmatched keys are `content` and flow
 * to the value-scrubbing stages.
 */
export function classifyKey(key: string, policy: KeyPolicy): KeyClass {
  if (policy.drop.some((p) => matches(key, p))) return 'drop';
  if (policy.safe.some((p) => matches(key, p))) return 'safe';
  return 'content';
}

/**
 * Structural key-policy stage: deletes `drop` keys outright (recording a
 * redaction) and passes `safe` + `content` keys through unchanged. Value-level
 * scrubbing of `content` keys is handled by later stages.
 */
export function keyPolicyStage(policy: KeyPolicy): ScrubStage {
  return {
    name: 'key-policy',
    version: VERSION,
    scrub(attributes: Attributes): ScrubResult {
      const out: Attributes = {};
      const redactions: RedactionRecord[] = [];
      for (const [key, value] of Object.entries(attributes)) {
        if (classifyKey(key, policy) === 'drop') {
          redactions.push({ key, stage: 'key-policy', kind: 'dropped-key' });
          continue;
        }
        out[key] = value;
      }
      return { attributes: out, redactions };
    },
  };
}
