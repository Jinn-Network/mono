import { classifyKey, type KeyPolicy } from './key-policy.js';
import type { Attributes, RedactionRecord, ScrubResult, ScrubStage } from './types.js';

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

const VERSION = '0.1.0';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * ML PII stage. Runs the injected NER detector over each `content`-classified
 * string value and replaces whole-word occurrences of each detected entity with
 * `[PII:<label>]` (word-boundary matching so substrings aren't corrupted — e.g.
 * detecting "London" leaves "Londoner" intact). `safe` and non-string values
 * pass through untouched. The detector returns matched text rather than offsets
 * because the Transformers.js NER pipeline does not surface character offsets.
 */
export function mlPiiStage(policy: KeyPolicy, detector: PiiDetector): ScrubStage {
  return {
    name: 'ml-pii',
    version: VERSION,
    async scrub(attributes: Attributes): Promise<ScrubResult> {
      const out: Attributes = {};
      const redactions: RedactionRecord[] = [];

      for (const [key, value] of Object.entries(attributes)) {
        if (typeof value !== 'string' || classifyKey(key, policy) !== 'content') {
          out[key] = value;
          continue;
        }

        let text = value;
        for (const ent of await detector.detect(value)) {
          if (!ent.text) continue;
          const re = new RegExp(`\\b${escapeRegExp(ent.text)}\\b`, 'g');
          const replaced = text.replace(re, `[PII:${ent.label}]`);
          if (replaced !== text) {
            redactions.push({ key, stage: 'ml-pii', kind: 'pii', detail: ent.label });
            text = replaced;
          }
        }
        out[key] = text;
      }

      return { attributes: out, redactions };
    },
  };
}
