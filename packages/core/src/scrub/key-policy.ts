import type { Attributes, RedactionRecord, ScrubResult, ScrubStage } from './types.js';
import type { Detector, Finding } from './finding.js';
import { applyDispositions } from './apply-dispositions.js';

export interface KeyPolicy {
  /** keys whose values are structural and safe to publish raw */
  safe: string[];
  /** keys to delete entirely (never published) — A5 structural drop */
  drop: string[];
  /**
   * Machine-identity keys (D3 carrier): attempt-manifest `host`, hostname
   * telemetry, and similar. Deleted at the key level (redact disposition) —
   * not reject-publish.
   */
  machineIdentity?: string[];
}

export type KeyClass = 'safe' | 'content' | 'drop' | 'machine-identity';

const VERSION = '0.3.0';

/** Exact match, or prefix match when the pattern ends with `*`. */
function matches(key: string, pattern: string): boolean {
  if (pattern.endsWith('*')) return key.startsWith(pattern.slice(0, -1));
  return key === pattern;
}

/**
 * Classify an attribute key against the policy. Precedence:
 * `drop` > `machine-identity` > `safe` > `content`. Fail-safe: a key matching
 * both drop and anything else is dropped.
 */
export function classifyKey(key: string, policy: KeyPolicy): KeyClass {
  if (policy.drop.some((p) => matches(key, p))) return 'drop';
  if ((policy.machineIdentity ?? []).some((p) => matches(key, p))) return 'machine-identity';
  if (policy.safe.some((p) => matches(key, p))) return 'safe';
  return 'content';
}

/**
 * Key-policy detector: emits A5 drop-key findings for `drop`-classified keys,
 * and D3 machine-identity findings for hostname/carrier keys.
 */
export function keyPolicyDetector(policy: KeyPolicy): Detector {
  const meta = { name: 'key-policy', version: VERSION };
  return {
    ...meta,
    detect(attributes: Attributes): Finding[] {
      const findings: Finding[] = [];
      for (const key of Object.keys(attributes)) {
        const cls = classifyKey(key, policy);
        if (cls === 'drop') {
          findings.push({
            class: 'A5',
            span: { key, start: 0, end: 0 },
            confidence: 'VERY_HIGH',
            evidence: ['drop-key'],
            detector: meta,
          });
        } else if (cls === 'machine-identity') {
          findings.push({
            class: 'D3',
            span: { key, start: 0, end: 0 },
            confidence: 'VERY_HIGH',
            evidence: ['machine-identity-key'],
            detector: meta,
          });
        }
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
