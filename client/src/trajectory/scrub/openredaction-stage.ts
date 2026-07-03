import { OpenRedaction } from 'openredaction';
import { classifyKey, type KeyPolicy } from './key-policy.js';
import type { Attributes, RedactionRecord, ScrubResult, ScrubStage } from './types.js';

const VERSION = '0.3.0';

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
 *
 * `LAB_TEST_ID` and `EXAM_ID` are denylisted for the same reason (#1348):
 * both trigger on ubiquitous software words (`\b(?:LAB|TEST|SAMPLE)…` and
 * `\b(?:EXAM|TEST|QUIZ|ASSESSMENT)…`, case-insensitive, same bare
 * `[A-Z0-9]{6,12}` tail) — "test-driven-development" came back as
 * `test-[LAB_8465]-development` — and lab-specimen / exam IDs are not
 * plausible in agent-trajectory content. Nothing in the seeded-secrets
 * fixture pins either pattern.
 */
export const BARE_WORD_PATTERN_DENYLIST: readonly string[] = [
  'INSTAGRAM_USERNAME',
  'XBOX_GAMERTAG',
  'PSN_ID',
  'NAME',
  'LAB_TEST_ID',
  'EXAM_ID',
];

/**
 * Trigger-word patterns excluded for #1372 (kept as a separate block from the
 * bare-word denylist above so parallel denylist additions merge cleanly).
 *
 * These share one pathology: an ordinary English trigger word (`TO`,
 * `APPROVAL`, `PROJECT`, `ORDER`, `REVIEW`, `PASS`, `LOT`, `SO`, `REG`, `WO`,
 * `MISSING`, `RETURN`, `user`, `prod`, `ice`…), case-insensitive, followed by
 * a bare `[A-Z0-9]{n,m}` tail with no intrinsic shape. On the published seed
 * skills' SKILL.md prose every one of them fired — all 42 seed bodies were
 * defaced ("project context" → `project [PROJECT_3875]`, "get your approval
 * before" → `approval [AUTH_5211]`), several mid-word ("something" →
 * `so[SO_1826]`, "workflow" → `wo[WO_3602]`, "regressions" →
 * `[REG]ressions`). Observed trigger words per pattern, from the #1372
 * characterisation over five real seed bodies:
 *
 * - `USERNAME` — "user intent", "user has"; a bare word after "user"/"login"
 *   is not a credential. Credentials keep their shaped patterns; person
 *   names are the ML PII stage's job (see the `NAME` note above).
 * - `PROJECT_CODE` — "project context", "project goes through".
 * - `CARD_AUTH_CODE` — "approval before" (card auth codes travel with card
 *   numbers, which `CREDIT_CARD` still catches).
 * - `IATA_AIRPORT_CODE` — "to use" ("TO" + any 3 capitalisable letters).
 * - `JUDGMENT_NUMBER` — "order should".
 * - `STANDING_ORDER_REF` — "SO" matches inside "something"/"solution".
 * - `PRODUCTION_ID` — "production classes"; nested self-replacement
 *   corrupted "NO PRODUCTION CODE" into `PROD[PROD[PROD…`.
 * - `WORK_ORDER_NUMBER` — "wo" matches inside "workflow"/"worktree".
 * - `PERFORMANCE_REVIEW_ID` — "performance problems", "evaluation between".
 * - `TNT_TRACKING` — every clause optional except the tail, so ANY 9- or
 *   13-character word matches ("variation", "statement").
 * - `THEME_PARK_TICKET` — "pass immediately".
 * - `TOURNAMENT_REGISTRATION_ID` — "REG" matches inside "regressions".
 * - `MISSING_PERSON_CASE` — "missing requirements".
 * - `RMA_NUMBER` — "return expected".
 * - `BATCH_LOT_NUMBER` — "a lot faster".
 * - `EMERGENCY_CONTACT` — "ice" (unanchored, matches inside "practice")
 *   followed by any 2–4 words.
 *
 * Lab-grade coverage loss is acceptable: these label niche reference numbers
 * (parcel tracking, theme-park tickets, tournament brackets, standing
 * orders, RMAs…) that are implausible in agent-trajectory content and carry
 * no shape of their own beyond the trigger word. Genuinely secret-shaped
 * content keeps its dedicated patterns (emails, cards, SSNs, API keys —
 * pinned below and by the harness-layer seeded-secrets fixture), and the
 * secretlint + plain-patterns stages still run behind this one.
 */
export const PROSE_TRIGGER_PATTERN_DENYLIST: readonly string[] = [
  'USERNAME',
  'PROJECT_CODE',
  'CARD_AUTH_CODE',
  'IATA_AIRPORT_CODE',
  'JUDGMENT_NUMBER',
  'STANDING_ORDER_REF',
  'PRODUCTION_ID',
  'WORK_ORDER_NUMBER',
  'PERFORMANCE_REVIEW_ID',
  'TNT_TRACKING',
  'THEME_PARK_TICKET',
  'TOURNAMENT_REGISTRATION_ID',
  'MISSING_PERSON_CASE',
  'RMA_NUMBER',
  'BATCH_LOT_NUMBER',
  'EMERGENCY_CONTACT',
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
    patterns: allTypes.filter(
      (t) => !BARE_WORD_PATTERN_DENYLIST.includes(t) && !PROSE_TRIGGER_PATTERN_DENYLIST.includes(t),
    ),
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
