import { lintSource } from '@secretlint/core';
import { creator } from '@secretlint/secretlint-rule-preset-recommend';
import { classifyKey, type KeyPolicy } from './key-policy.js';
import type { Attributes, RedactionRecord, ScrubResult, ScrubStage } from './types.js';

const VERSION = '0.1.0';
const PRESET_RULE_ID = '@secretlint/secretlint-rule-preset-recommend';

// Entropy fallback thresholds. Conservative on purpose: a long token whose
// character distribution is near-random is almost certainly a key/token, not
// prose. Tunable; raise the bar if legitimate high-entropy content over-redacts.
const ENTROPY_MIN_LEN = 20;
const ENTROPY_MIN_BITS = 4.0;

function shannonEntropy(s: string): number {
  const freq: Record<string, number> = {};
  for (const ch of s) freq[ch] = (freq[ch] ?? 0) + 1;
  let e = 0;
  for (const count of Object.values(freq)) {
    const p = count / s.length;
    e -= p * Math.log2(p);
  }
  return e;
}

/** Short label from a secretlint ruleId, e.g. `@secretlint/secretlint-rule-github` → `github`. */
function shortRule(ruleId: string): string {
  return ruleId.replace(/^@secretlint\/secretlint-rule-/, '').replace(/^@secretlint\//, '');
}

/**
 * Secrets stage. Two passes over each `content`-classified string value:
 *  1. secretlint preset-recommend rules (AWS, GitHub, Slack, GCP, npm, …) —
 *     each match replaced inline with `[SECRET:<rule>]`.
 *  2. a conservative Shannon-entropy fallback that catches long, near-random
 *     tokens no specific rule matched, replaced with `[SECRET:high-entropy]`.
 * `safe` and non-string values pass through untouched.
 */
export function secretlintStage(policy: KeyPolicy): ScrubStage {
  const config = { rules: [{ id: PRESET_RULE_ID, rule: creator }] };

  return {
    name: 'secretlint',
    version: VERSION,
    async scrub(attributes: Attributes): Promise<ScrubResult> {
      const out: Attributes = {};
      const redactions: RedactionRecord[] = [];

      for (const [key, value] of Object.entries(attributes)) {
        if (typeof value !== 'string' || classifyKey(key, policy) !== 'content') {
          out[key] = value;
          continue;
        }

        // Pass 1 — rule-based detection.
        const result = await lintSource({
          source: { filePath: '/span', content: value, ext: '.txt', contentType: 'text' },
          options: { config },
        });
        let text = value;
        // Replace from last range to first so earlier indices stay valid.
        const ranges = [...result.messages].sort((a, b) => b.range[0] - a.range[0]);
        for (const m of ranges) {
          const label = shortRule(m.ruleId);
          text = text.slice(0, m.range[0]) + `[SECRET:${label}]` + text.slice(m.range[1]);
          redactions.push({ key, stage: 'secretlint', kind: 'secret', detail: label });
        }

        // Pass 2 — entropy fallback on whatever survived.
        text = text.replace(/\S+/g, (token) => {
          if (token.length >= ENTROPY_MIN_LEN && shannonEntropy(token) >= ENTROPY_MIN_BITS) {
            redactions.push({ key, stage: 'secretlint', kind: 'secret', detail: 'high-entropy' });
            return '[SECRET:high-entropy]';
          }
          return token;
        });

        out[key] = text;
      }

      return { attributes: out, redactions };
    },
  };
}
