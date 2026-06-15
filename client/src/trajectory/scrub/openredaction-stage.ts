import { OpenRedaction } from 'openredaction';
import { classifyKey, type KeyPolicy } from './key-policy.js';
import type { Attributes, RedactionRecord, ScrubResult, ScrubStage } from './types.js';

const VERSION = '0.1.0';

/**
 * Structured-PII stage backed by `openredaction` (570+ curated regex patterns +
 * checksum validation, e.g. Luhn for cards). Runs only on `content`-classified
 * string attributes; `safe` and non-string values pass through untouched. Each
 * detection is replaced inline (openredaction's placeholder substitution) and
 * recorded as a `pii` redaction for the provenance manifest.
 *
 * The detector is constructed once at factory time and reused across spans
 * (pattern compilation is not free).
 */
export function openredactionStage(
  policy: KeyPolicy,
  detector: OpenRedaction = new OpenRedaction(),
): ScrubStage {
  return {
    name: 'openredaction',
    version: VERSION,
    async scrub(attributes: Attributes): Promise<ScrubResult> {
      const out: Attributes = {};
      const redactions: RedactionRecord[] = [];
      for (const [key, value] of Object.entries(attributes)) {
        if (typeof value !== 'string' || classifyKey(key, policy) !== 'content') {
          out[key] = value;
          continue;
        }
        const result = await detector.detect(value);
        out[key] = result.redacted;
        for (const det of result.detections) {
          redactions.push({ key, stage: 'openredaction', kind: 'pii', detail: det.type });
        }
      }
      return { attributes: out, redactions };
    },
  };
}
