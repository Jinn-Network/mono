import { OpenRedaction } from 'openredaction';
import { classifyKey, type KeyPolicy } from './key-policy.js';
import type { Attributes, RedactionRecord, ScrubResult, ScrubStage } from './types.js';

const VERSION = '0.2.0';

/**
 * Patterns excluded from the default detector (#1331). All three ship with a
 * bare-word regex (`\b[a-zA-Z0-9._]{3,30}\b` or equivalent) that matches
 * nearly every token of ordinary technical prose — "Update the staging
 * bucket config" came back as `[IG_USER_…] the staging [IG_USER_…]
 * [IG_USER_…]`, destroying the readability and distillation value of every
 * published trajectory. A social handle has no shape of its own outside its
 * platform context, so dropping these loses no genuine coverage: emails,
 * keys, cards, SSNs, phones etc. all keep their dedicated patterns (pinned
 * by test/trajectory/scrub/openredaction-tuning.test.ts and the
 * harness-layer seeded-secrets fixture).
 *
 * `NAME` is denylisted for the same reason with an acknowledged trade-off:
 * its follower branch accepts lowercase words (`[A-Z][a-z…]+ (\s+[a-z…]+){1,3}`),
 * so ANY sentence-initial capitalised word plus 1–3 words matches — "Fix the
 * failing test" is a "name" to it, which mangles the first sentence of
 * essentially every task summary. Person-name detection is the ML PII
 * stage's job (GLiNER, `mlPiiStage`), which the daemon wires when the model
 * is available; a bare unlabelled name in prose is not regex-detectable at
 * acceptable precision.
 */
export const BARE_WORD_PATTERN_DENYLIST: readonly string[] = [
  'INSTAGRAM_USERNAME',
  'XBOX_GAMERTAG',
  'PSN_ID',
  'NAME',
];

/**
 * Default detector: openredaction's full pattern set minus the audited
 * bare-word matchers. Built via the `patterns` whitelist option (the
 * library has no exclude option), so a version bump that renames patterns
 * fails loudly in the tuning tests rather than silently re-enabling junk.
 */
export function buildDefaultDetector(): OpenRedaction {
  const allTypes = [...new Set(new OpenRedaction().getPatterns().map((p) => p.type))];
  return new OpenRedaction({
    patterns: allTypes.filter((t) => !BARE_WORD_PATTERN_DENYLIST.includes(t)),
  });
}

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
  detector: OpenRedaction = buildDefaultDetector(),
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
