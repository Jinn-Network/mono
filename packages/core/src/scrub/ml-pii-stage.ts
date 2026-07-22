import { applyDispositions } from './apply-dispositions.js';
import type { Detector, Finding } from './finding.js';
import { classifyKey, type KeyPolicy } from './key-policy.js';
import type { Attributes, ScrubStage } from './types.js';

/** A PII entity detected in text: a label (PER/ORG/LOC/…) and the matched span text. */
export interface PiiEntity {
  label: string;
  text: string;
}

/**
 * ML PII detector seam. The production implementation wraps a Transformers.js
 * token-classification (NER) model; tests inject a deterministic fake. Kept
 * behind an interface so the stage logic is unit-tested without loading a model.
 */
export interface PiiDetector {
  detect(text: string): Promise<PiiEntity[]>;
}

const VERSION = '0.2.0';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function classForLabel(label: string): Finding['class'] {
  const l = label.toUpperCase();
  if (l === 'PER' || l === 'PERSON' || l.includes('PERSON')) return 'B3';
  if (l.includes('PHONE')) return 'B5';
  if (l.includes('LOC') || l.includes('ADDRESS')) return 'B6';
  return 'E1';
}

/**
 * ML PII detector — emits B3/E1 findings from NER entity text matches.
 * Offsets recovered via whole-word search (Transformers.js has no char offsets).
 */
export function mlPiiDetector(policy: KeyPolicy, detector: PiiDetector): Detector {
  const meta = { name: 'ml-pii', version: VERSION };
  return {
    ...meta,
    async detect(attributes: Attributes): Promise<Finding[]> {
      const findings: Finding[] = [];
      for (const [key, value] of Object.entries(attributes)) {
        if (typeof value !== 'string' || classifyKey(key, policy) !== 'content') continue;
        for (const ent of await detector.detect(value)) {
          if (!ent.text) continue;
          const re = new RegExp(`\\b${escapeRegExp(ent.text)}\\b`, 'g');
          let match: RegExpExecArray | null;
          while ((match = re.exec(value)) !== null) {
            findings.push({
              class: classForLabel(ent.label),
              span: { key, start: match.index, end: match.index + match[0]!.length },
              confidence: 'VERY_HIGH',
              evidence: [`ml:${ent.label}`],
              detector: meta,
            });
          }
        }
      }
      return findings;
    },
  };
}

/**
 * Legacy ScrubStage wrapper around {@link mlPiiDetector}.
 */
export function mlPiiStage(policy: KeyPolicy, detector: PiiDetector): ScrubStage {
  const det = mlPiiDetector(policy, detector);
  return {
    name: det.name,
    version: det.version,
    async scrub(attributes: Attributes) {
      const findings = await det.detect(attributes);
      return applyDispositions(attributes, findings);
    },
  };
}
