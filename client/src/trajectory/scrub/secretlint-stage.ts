import { lintSource } from '@secretlint/core';
import { creator } from '@secretlint/secretlint-rule-preset-recommend';
import { classifyKey, type KeyPolicy } from './key-policy.js';
import type { Attributes, RedactionRecord, ScrubResult, ScrubStage } from './types.js';

const VERSION = '0.3.0'; // 0.3.0: entropy replacement preserves wrapping delimiters (#1378)
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

// Tuning note (#1348): a path-shaped token — slug segments joined by `/`,
// e.g. `obra/superpowers/skills/test-driven-development` — is judged
// per-SEGMENT, not whole-token, but ONLY when the whole token mixes at most
// 2 character classes. Concatenating several short human-readable slugs
// inflates whole-token Shannon entropy past 4.0 bits/char purely by
// length/variety, which was redacting seed-import task summaries as
// `[SECRET:high-entropy]`; real slugs are overwhelmingly lowercase (1–2
// classes), while secrets that merely contain `/` or `.` (AWS-style base64
// keys, `dir/<blob>.tar.gz` filenames) almost always mix 3 classes and keep
// the original whole-token entropy behaviour. The segment charset excludes
// `+` and `=`, so base64 blobs containing either are never path-shaped.
// Residual exposure: a secret with ≤ 2 whole-token character classes whose
// every `[/.]`-split segment is under 16 chars (or below the entropy bar)
// qualifies as a path and escapes the fallback.
const PATH_SHAPED = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)+$/;

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
 *
 * Path carve-out (#1348): a PATH_SHAPED token whose WHOLE-token character-
 * class count is ≤ 2 is redacted only when at least one `[/.]`-delimited
 * segment independently passes the strict shape gate (length ≥
 * ENTROPY_MIN_LEN, entropy ≥ ENTROPY_MIN_BITS, secret charset, ≥ 2 character
 * classes) — applied at ALL lengths, so a long path of short slugs never
 * trips the whole-token entropy bar, while a real key embedded as a path
 * segment (`api/v1/ghp_…`) still redacts. A path-shaped token mixing ≥ 3
 * whole-token classes never takes the carve-out — real slugs are 1–2
 * classes, and 3-class "paths" are secrets wearing slashes/dots (#1348
 * review finding) — it falls through to the whole-token logic below.
 * Splitting on dots as well as slashes means a sentence full stop or a file
 * extension yields its own (failing) segment instead of poisoning the
 * secret blob next to it. Non-path tokens are unaffected.
 */
function isSecretShapedToken(token: string): boolean {
  if (token.length < ENTROPY_MIN_LEN) return false;
  if (PATH_SHAPED.test(token) && charClassCount(token) <= 2) {
    return token.split(/[/.]/).some(
      (segment) =>
        segment.length >= ENTROPY_MIN_LEN &&
        shannonEntropy(segment) >= ENTROPY_MIN_BITS &&
        SECRET_CHARSET.test(segment) &&
        charClassCount(segment) >= 2,
    );
  }
  if (shannonEntropy(token) < ENTROPY_MIN_BITS) return false;
  if (token.length >= ENTROPY_STRICT_LEN) return true;
  return SECRET_CHARSET.test(token) && charClassCount(token) >= 2;
}

/** Short label from a secretlint ruleId, e.g. `@secretlint/secretlint-rule-github` → `github`. */
function shortRule(ruleId: string): string {
  return ruleId.replace(/^@secretlint\/secretlint-rule-/, '').replace(/^@secretlint\//, '');
}

// #1378 cosmetic: a `\S+` token inside serialised JSON drags its wrapping
// delimiters along (`"…/blob",` is one whitespace-delimited token), so
// replacing the whole token swallowed the quotes/comma and left malformed
// JSON (`"resolved_path": [SECRET:high-entropy] "files_modified": …`). Split
// each token into leading punctuation / core / trailing punctuation, gate on
// the core, and reattach the punctuation around the placeholder. None of the
// stripped characters belong to SECRET_CHARSET (`=` deliberately excluded —
// base64 padding), so no secret material is ever preserved; if anything,
// stripping the wrapper improves detection (the 16–19 char shape gate
// previously failed on quoted tokens because the quotes broke the charset).
const TOKEN_WRAPPING = /^([("'`[{,;:]*)([\s\S]*?)([)"'`\]},;:.]*)$/;

/**
 * Secrets stage. Two passes over each `content`-classified string value:
 *  1. secretlint preset-recommend rules (AWS, GitHub, Slack, GCP, npm, …) —
 *     each match replaced inline with `[SECRET:<rule>]`.
 *  2. a conservative Shannon-entropy + secret-shape fallback that catches
 *     near-random tokens no specific rule matched (≥ 20 chars by entropy alone,
 *     or 16–19 chars when the token is a single high-density secret-charset run
 *     mixing multiple character classes), replaced with `[SECRET:high-entropy]`.
 *     Path-shaped tokens (`owner/repo/slug` and friends, #1348) are judged
 *     per-segment rather than whole-token, so slug identifiers survive while a
 *     secret embedded as a path segment still redacts.
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
        // Wrapping punctuation is preserved around the placeholder (#1378).
        text = text.replace(/\S+/g, (token) => {
          const [, lead = '', core = token, trail = ''] = TOKEN_WRAPPING.exec(token) ?? [];
          if (isSecretShapedToken(core)) {
            redactions.push({ key, stage: 'secretlint', kind: 'secret', detail: 'high-entropy' });
            return `${lead}[SECRET:high-entropy]${trail}`;
          }
          return token;
        });

        out[key] = text;
      }

      return { attributes: out, redactions };
    },
  };
}
