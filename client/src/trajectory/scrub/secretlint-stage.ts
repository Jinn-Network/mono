import { lintSource } from '@secretlint/core';
import { creator } from '@secretlint/secretlint-rule-preset-recommend';
import { classifyKey, type KeyPolicy } from './key-policy.js';
import type { Attributes, RedactionRecord, ScrubResult, ScrubStage } from './types.js';

const VERSION = '0.1.0';
const PRESET_RULE_ID = '@secretlint/secretlint-rule-preset-recommend';

// Entropy fallback thresholds. Conservative on purpose: a long token whose
// character distribution is near-random is almost certainly a key/token, not
// prose. Tunable; raise the bar if legitimate high-entropy content over-redacts.
//
// `ENTROPY_MIN_BITS` stays at 4.0: English prose sits ~4.0–4.5 bits/char, so
// lowering it below 4.0 globally nukes legitimate prose. `ENTROPY_MIN_LEN` is
// lowered from 20 → 16 so secret-shaped tokens in the 16–19 char band (which
// the old 20-char floor never even considered) are caught — but only when they
// ALSO pass the structural shape gate below, so the longer tail of legit
// identifiers/words in that band is not swept in. Tokens of length ≥ 20 keep
// the original entropy-only behaviour (the shape gate does not narrow it).
const ENTROPY_MIN_LEN = 16;
const ENTROPY_MIN_BITS = 4.0;
// Above this length the entropy bar alone decides (original behaviour). Between
// ENTROPY_MIN_LEN and here the structural shape gate is additionally required.
const ENTROPY_STRICT_LEN = 20;

// A "secret-shaped" token: a single run of base64 / base64url / hex charset
// characters only (letters, digits, and the `+/=_-` set), with NO natural-language
// punctuation or spaces.
const SECRET_CHARSET = /^[A-Za-z0-9+/=_-]+$/;

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

/** Count distinct character classes present (lowercase / uppercase / digit). */
function charClassCount(s: string): number {
  let n = 0;
  if (/[a-z]/.test(s)) n += 1;
  if (/[A-Z]/.test(s)) n += 1;
  if (/[0-9]/.test(s)) n += 1;
  return n;
}

/**
 * Decide whether a single whitespace-delimited token should be redacted as a
 * high-entropy / secret-shaped value. Purely additive over the original rule:
 *  - length ≥ ENTROPY_STRICT_LEN (20): entropy bar alone (unchanged behaviour),
 *  - ENTROPY_MIN_LEN (16) ≤ length < 20: entropy bar AND the structural shape
 *    gate — the token must be a single secret-charset run mixing ≥ 2 character
 *    classes (so dictionary words + a trailing suffix like `authentication123`,
 *    which sit below 4.0 bits/char anyway, are not swept in).
 * Never fires below ENTROPY_MIN_LEN.
 */
function isSecretShapedToken(token: string): boolean {
  if (token.length < ENTROPY_MIN_LEN) return false;
  if (shannonEntropy(token) < ENTROPY_MIN_BITS) return false;
  if (token.length >= ENTROPY_STRICT_LEN) return true;
  return SECRET_CHARSET.test(token) && charClassCount(token) >= 2;
}

/** Short label from a secretlint ruleId, e.g. `@secretlint/secretlint-rule-github` → `github`. */
function shortRule(ruleId: string): string {
  return ruleId.replace(/^@secretlint\/secretlint-rule-/, '').replace(/^@secretlint\//, '');
}

/**
 * Secrets stage. Two passes over each `content`-classified string value:
 *  1. secretlint preset-recommend rules (AWS, GitHub, Slack, GCP, npm, …) —
 *     each match replaced inline with `[SECRET:<rule>]`.
 *  2. a conservative Shannon-entropy + secret-shape fallback that catches
 *     near-random tokens no specific rule matched (≥ 20 chars by entropy alone,
 *     or 16–19 chars when the token is a single high-density secret-charset run
 *     mixing multiple character classes), replaced with `[SECRET:high-entropy]`.
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

        // Pass 2 — entropy + secret-shape fallback on whatever survived.
        text = text.replace(/\S+/g, (token) => {
          if (isSecretShapedToken(token)) {
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
