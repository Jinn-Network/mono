import type { Attributes, RedactionRecord, ScrubResult, ScrubStage } from './types.js';
import type { Detector, Finding } from './finding.js';
import { applyDispositions } from './apply-dispositions.js';

export interface KeyPolicy {
  /** keys whose values are structural and safe to publish raw */
  safe: string[];
  /** keys to delete entirely (never published) */
  drop: string[];
}

export type KeyClass = 'safe' | 'content' | 'drop';

const VERSION = '0.2.0';

/** Exact match, or prefix match when the pattern ends with `*`. */
function matches(key: string, pattern: string): boolean {
  if (pattern.endsWith('*')) return key.startsWith(pattern.slice(0, -1));
  return key === pattern;
}

/**
 * Classify an attribute key against the policy. `drop` wins over `safe` (a key
 * matching both is dropped — fail safe). Unmatched keys are `content` and flow
 * to the value-scrubbing detectors.
 */
export function classifyKey(key: string, policy: KeyPolicy): KeyClass {
  if (policy.drop.some((p) => matches(key, p))) return 'drop';
  if (policy.safe.some((p) => matches(key, p))) return 'safe';
  return 'content';
}

/**
 * Key-policy detector: emits A5 drop-key findings for `drop`-classified keys.
 * Disposition removes the key (reject-publish / redact).
 */
export function keyPolicyDetector(policy: KeyPolicy): Detector {
  const meta = { name: 'key-policy', version: VERSION };
  return {
    ...meta,
    detect(attributes: Attributes): Finding[] {
      const findings: Finding[] = [];
      for (const key of Object.keys(attributes)) {
        if (classifyKey(key, policy) !== 'drop') continue;
        findings.push({
          class: 'A5',
          span: { key, start: 0, end: 0 },
          confidence: 'VERY_HIGH',
          evidence: ['drop-key'],
          detector: meta,
        });
      }
      return findings;
    },
  };
}

/**
 * Legacy ScrubStage wrapper around {@link keyPolicyDetector}.
 */
export function keyPolicyStage(policy: KeyPolicy): ScrubStage {
  const detector = keyPolicyDetector(policy);
  return {
    name: detector.name,
    version: detector.version,
    scrub(attributes: Attributes): ScrubResult {
      const findings = detector.detect(attributes) as Finding[];
      const applied = applyDispositions(attributes, findings);
      return { attributes: applied.attributes, redactions: applied.redactions as RedactionRecord[] };
    },
  };
}
