import { applyDispositions } from './apply-dispositions.js';
import type { Band, Detector, Finding } from './finding.js';
import { classifyKey, type KeyPolicy } from './key-policy.js';
import type { Attributes, ScrubStage } from './types.js';

/**
 * A PII entity detected in text. When the detector supplies character offsets
 * (`start`/`end`), those win; otherwise the stage recovers spans via whole-word
 * search (Transformers.js NER fallback). Optional `score` maps to a Band.
 */
export interface PiiEntity {
  label: string;
  text: string;
  /** Inclusive start offset in the source string, when the detector provides it. */
  start?: number;
  /** Exclusive end offset in the source string, when the detector provides it. */
  end?: number;
  /** Model confidence in [0, 1]. Mapped via {@link scoreToBand}. */
  score?: number;
}

/**
 * ML PII detector seam. Production uses GLiNER ONNX (`gliner-detector.ts`);
 * TransformersPiiDetector remains for tests. Kept behind an interface so stage
 * logic is unit-tested without loading a model.
 */
export interface PiiDetector {
  detect(text: string): Promise<PiiEntity[]>;
}

const VERSION = '0.3.0';

/**
 * Map a model score onto a DLP-style Band (#1973 / design §6.1).
 *
 * Thresholds chosen so B3 policy (VERY_HIGH → redact; HIGH/MEDIUM → flag)
 * separates auto-redact names from review-queue candidates.
 */
export function scoreToBand(score: number | undefined): Band {
  if (score === undefined || Number.isNaN(score)) return 'VERY_HIGH';
  if (score >= 0.85) return 'VERY_HIGH';
  if (score >= 0.7) return 'HIGH';
  if (score >= 0.55) return 'MEDIUM';
  return 'LOW';
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function classForLabel(label: string): Finding['class'] {
  const l = label.toUpperCase();
  if (l === 'PER' || l === 'PERSON' || l.includes('PERSON') || l === 'NAME') return 'B3';
  if (l.includes('PHONE') || l.includes('TEL')) return 'B5';
  if (l.includes('EMAIL')) return 'B1';
  if (l.includes('LOC') || l.includes('ADDRESS') || l.includes('STREET')) return 'B6';
  if (l.includes('USER') || l.includes('HANDLE') || l.includes('USERNAME')) return 'B4';
  if (l.includes('IP')) return 'D2';
  if (
    l.includes('CARD') ||
    l.includes('IBAN') ||
    l.includes('SSN') ||
    l.includes('SOCIAL SECURITY')
  ) {
    return 'B7';
  }
  return 'E1';
}

function offsetsValid(
  text: string,
  start: number | undefined,
  end: number | undefined,
): { start: number; end: number } | null {
  if (
    typeof start !== 'number' ||
    typeof end !== 'number' ||
    start < 0 ||
    end > text.length ||
    start >= end
  ) {
    return null;
  }
  return { start, end };
}

/**
 * ML PII detector — emits B3/B5/B6/… findings from NER/GLiNER entities.
 * Prefers detector-supplied offsets; falls back to whole-word search.
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
          const confidence = scoreToBand(ent.score);
          const evidence = [`ml:${ent.label}`];
          if (typeof ent.score === 'number') {
            evidence.push(`score:${ent.score.toFixed(3)}`);
          }

          const offsets = offsetsValid(value, ent.start, ent.end);
          if (offsets) {
            findings.push({
              class: classForLabel(ent.label),
              span: { key, start: offsets.start, end: offsets.end },
              confidence,
              evidence,
              detector: meta,
            });
            continue;
          }

          // Offset-less fallback (Transformers.js NER).
          const re = new RegExp(`\\b${escapeRegExp(ent.text)}\\b`, 'g');
          let match: RegExpExecArray | null;
          while ((match = re.exec(value)) !== null) {
            findings.push({
              class: classForLabel(ent.label),
              span: { key, start: match.index, end: match.index + match[0]!.length },
              confidence,
              evidence,
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
