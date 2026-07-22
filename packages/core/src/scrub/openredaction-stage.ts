import { OpenRedaction } from 'openredaction';
import { applyDispositions } from './apply-dispositions.js';
import type { Detector, Finding, ScrubClass } from './finding.js';
import { classifyKey, type KeyPolicy } from './key-policy.js';
import type { Attributes, ScrubStage } from './types.js';

const VERSION = '0.5.0'; // 0.5.0: emit findings (#1969); temporary until #1973 retires this detector

/**
 * The narrow detector contract core exposes. Keeping the public signature
 * structural prevents openredaction's unrelated Express server declarations
 * from leaking into every installed client's declaration graph.
 */
export interface OpenRedactionDetector {
  detect(text: string): Promise<{
    redacted: string;
    detections: Array<{ type: string }>;
  }>;
  getPatterns(): Array<{ type: string; regex: RegExp }>;
}

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
 *
 * #1391 additions (full 42-seed characterisation) — bare-SHAPE patterns
 * whose regex matches ordinary technical tokens with no trigger word at all:
 *
 * - `ZIP_CODE_US` — `\b\d{5}(…)?\b`: ANY 5-digit number. Fired on GitHub
 *   issue numbers ("#26251", "#41417"), millisecond values ("60000"), quota
 *   figures ("25000"), Lark error codes ("41050"). A bare 5-digit number in
 *   trajectory content is overwhelmingly a count, id, or port, not a home
 *   address component; street-level address detection is the ML PII stage's
 *   job, where the surrounding words disambiguate.
 * - `POSTCODE_UK` — matches hex colour literals ("#FF00FF" → `[POSTCODE]`).
 *   Same rationale: a bare alphanumeric cluster is not a location without
 *   context, which the ML PII stage has and this regex does not.
 * - `SWIFT_BIC` — `\b[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?\b`: ANY 8- or 11-char
 *   uppercase word ("REQUIRED", from an HTTP header name). BIC codes are
 *   public bank identifiers, not secrets, and the shape is indistinguishable
 *   from an all-caps word.
 * - `TIKTOK_USERNAME` / `SOCIAL_MEDIA_HANDLE` — the #1331 social-handle
 *   family: `@`-prefixed bare words. Fired on npm scoped packages
 *   ("@n8n/n8n-nodes-langchain…", "@github/copilot-sdk"), which are
 *   ubiquitous in technical prose.
 */
export const BARE_WORD_PATTERN_DENYLIST: readonly string[] = [
  'INSTAGRAM_USERNAME',
  'XBOX_GAMERTAG',
  'PSN_ID',
  'NAME',
  'LAB_TEST_ID',
  'EXAM_ID',
  // #1391:
  'ZIP_CODE_US',
  'POSTCODE_UK',
  'SWIFT_BIC',
  'TIKTOK_USERNAME',
  'SOCIAL_MEDIA_HANDLE',
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
 *
 * #1391 additions — the #1372 characterisation ran 5 sample bodies; the
 * full-42-seed sweep surfaced the longer tail below (same pathology, same
 * fix, observed trigger words in parentheses). One aggravator worth naming:
 * openredaction substitutes a detection's captured VALUE case-insensitively
 * across the whole document, so a single trigger FP defaces every other
 * occurrence of that value. Every seed's frontmatter contains
 * `license: MIT` — LICENSE_PLATE captures `MIT`, and every "limit(s)" /
 * "submit" in the body came back as `li[PLATE_2299]s` / `Sub[PLATE_2299]`.
 *
 * - `LICENSE_PLATE` — "license: MIT" (frontmatter, all 42 seeds); `REG`
 *   trigger mid-word ("registers" → `[PLATE]isters`).
 * - `US_LICENSE_PLATE` / `INTERNATIONAL_LICENSE_PLATE` — same trigger family
 *   (`PLATE|LICENSE|TAG|REGISTRATION`): "tag-driven", "tagged as data".
 * - `EDITORIAL_TICKET` — "edit existing", "edit endpoints" (`EDIT` trigger).
 * - `TRANSACTION_ID` — `TRANS` trigger mid-word: "transformations" →
 *   `[TXN]formations`.
 * - `AIRLINE_BOOKING_REFERENCE` — "reference images", "reference videos",
 *   "node reference syntax" (`REFERENCE` trigger).
 * - `SOURCE_ID` — "source images", "source directory", "multi-source
 *   aggregation".
 * - `SERVICE_REQUEST_NUMBER` — "service discovery", "app-service assessment".
 * - `TERMINAL_ID` — "terminal status"; `POS` trigger mid-word: "false
 *   positives", "PostToolUse".
 * - `EXIT_INTERVIEW_ID` — "termination criterion/oracle", "separation
 *   exists" (`EXIT|TERMINATION|SEPARATION` triggers).
 * - `HOTEL_LOYALTY_NUMBER` — "member-remove" (wiki commands), "rewards
 *   padding" (`MEMBER|LOYALTY|REWARDS` triggers).
 * - `SEARCH_RESCUE_MISSION_ID` — "search operations", "web/search results"
 *   (`SEARCH|RESCUE|MISSION` triggers).
 * - `APPLICATION_ID` / `JOB_APPLICATION_ID` — "application gateway",
 *   "candidate contradicts", "candidate regions" (`APPLICATION|CANDIDATE|
 *   APPLICANT` triggers).
 * - `ARTICLE_ID` — "user story should", "user-story-example" (`STORY`
 *   trigger).
 * - `EMERGENCY_CALL_REF` — "incident investigation" (`INCIDENT` trigger).
 * - `CAMPAIGN_CODE` — "brand campaigns", "brand campaign jingle".
 * - `INSTALLATION_REF` — "brew install imagemagick", "apt-get install".
 * - `PRODUCT_SKU` — "SKU changes", "SKU upgrades" (Azure sizing prose).
 * - `BAR_NUMBER` — "raises the bar because" (`BAR` trigger).
 * - `PREMIUM_PAYMENT_REF` — "premium commercial cuts", "premium brand".
 * - `HOUSING_ASSIGNMENT` — "ambient room tone" (`ROOM` trigger).
 * - `MANUSCRIPT_ID` — `MS` trigger: "0.8 ms overhead" → `[MANUSCRIPT]`.
 * - `STATEMENT_REF` — "return statement exists".
 * - `QUOTE_REFERENCE` — "quote shortest decisive line".
 * - `RESUME_ID` — "Resume caveman after" (`RESUME|CV` triggers).
 * - `PAYMENT_REFERENCE` — `PAY` trigger mid-word: "paymentGateway" →
 *   `pay[PAY_REF]`.
 * - `ROUTING_NUMBER_MFG` — "routing convention".
 * - `MICROSOFT_CERTIFICATION` — "Microsoft documentation" (`MICROSOFT|MS`
 *   triggers).
 *
 * Revealed at fixpoint (iteration 2 — patterns previously shadowed by a
 * higher-priority pattern that the first pass denylisted):
 * - `INCIDENT_REPORT_NUMBER` — "Incident Investigation" (`INCIDENT` trigger,
 *   surfaced once EMERGENCY_CALL_REF was gone).
 * - `ENROLLMENT_NUMBER` — "registration succeeds" (`REGISTRATION` trigger).
 * - `HOTEL_RESERVATION` — "Capacity Reservation Groups" (`RESERVATION`
 *   trigger, surfaced once AIRLINE_BOOKING_REFERENCE was gone).
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
  // #1391:
  'LICENSE_PLATE',
  'US_LICENSE_PLATE',
  'INTERNATIONAL_LICENSE_PLATE',
  'EDITORIAL_TICKET',
  'TRANSACTION_ID',
  'AIRLINE_BOOKING_REFERENCE',
  'SOURCE_ID',
  'SERVICE_REQUEST_NUMBER',
  'TERMINAL_ID',
  'EXIT_INTERVIEW_ID',
  'HOTEL_LOYALTY_NUMBER',
  'SEARCH_RESCUE_MISSION_ID',
  'APPLICATION_ID',
  'JOB_APPLICATION_ID',
  'ARTICLE_ID',
  'EMERGENCY_CALL_REF',
  'CAMPAIGN_CODE',
  'INSTALLATION_REF',
  'PRODUCT_SKU',
  'BAR_NUMBER',
  'PREMIUM_PAYMENT_REF',
  'HOUSING_ASSIGNMENT',
  'MANUSCRIPT_ID',
  'STATEMENT_REF',
  'QUOTE_REFERENCE',
  'RESUME_ID',
  'PAYMENT_REFERENCE',
  'ROUTING_NUMBER_MFG',
  'MICROSOFT_CERTIFICATION',
  // #1391 fixpoint iteration 2:
  'INCIDENT_REPORT_NUMBER',
  'ENROLLMENT_NUMBER',
  'HOTEL_RESERVATION',
];

/**
 * Default detector: openredaction's full pattern set minus the audited
 * bare-word matchers. Built via the `patterns` whitelist option (the
 * library has no exclude option), so a version bump that renames patterns
 * fails loudly in the tuning tests rather than silently re-enabling junk.
 */
export function buildDefaultDetector(): OpenRedactionDetector {
  const allTypes = [...new Set(new OpenRedaction().getPatterns().map((p) => p.type))];
  return new OpenRedaction({
    patterns: allTypes.filter(
      (t) => !BARE_WORD_PATTERN_DENYLIST.includes(t) && !PROSE_TRIGGER_PATTERN_DENYLIST.includes(t),
    ),
  });
}

/**
 * Map openredaction's library-native type names onto the §3.2 ScrubClass
 * taxonomy. Unknown types land in E1 (flag by default) so they stay audible
 * without inventing a class.
 */
export function scrubClassFromOpenredactionType(type: string): ScrubClass {
  const t = type.toUpperCase();
  if (t.includes('EMAIL')) return 'B1';
  if (t.includes('ETHEREUM') || t === 'ETH_ADDRESS' || t.includes('ETH_ADDR')) return 'C1';
  if (t.includes('PATH') || t.includes('HOME')) return 'D1';
  if (t.includes('PHONE') || t.includes('TEL')) return 'B5';
  if (t.includes('IP_') || t === 'IPV4' || t === 'IPV6' || t.includes('IP_ADDRESS')) return 'D2';
  if (t.includes('CREDIT') || t.includes('CARD') || t.includes('IBAN') || t.includes('SSN')) return 'B7';
  if (t.includes('NAME') || t.includes('PERSON')) return 'B3';
  return 'E1';
}

/**
 * Structured-PII detector backed by `openredaction`. Temporary strangler
 * (#1969 → #1973): still only wired into the trace preset; emits findings
 * from library matches (offsets recovered via the library's own patterns)
 * so disposition owns stubs. Seed/layer2 never include this detector.
 */
export function openredactionDetector(
  policy: KeyPolicy,
  detector: OpenRedactionDetector = buildDefaultDetector(),
): Detector {
  const meta = { name: 'openredaction', version: VERSION };
  const patterns = detector.getPatterns();

  return {
    ...meta,
    async detect(attributes: Attributes): Promise<Finding[]> {
      const findings: Finding[] = [];
      for (const [key, value] of Object.entries(attributes)) {
        if (typeof value !== 'string' || classifyKey(key, policy) !== 'content') continue;

        const result = await detector.detect(value);
        if (result.detections.length === 0) continue;

        const detectedTypes = new Set(result.detections.map((d) => d.type));
        // Recover offsets from the library patterns for detected types.
        const recoveredTypes = new Set<string>();
        for (const pattern of patterns) {
          if (!detectedTypes.has(pattern.type)) continue;
          const re = new RegExp(
            pattern.regex.source,
            pattern.regex.flags.includes('g') ? pattern.regex.flags : `${pattern.regex.flags}g`,
          );
          let match: RegExpExecArray | null;
          while ((match = re.exec(value)) !== null) {
            findings.push({
              class: scrubClassFromOpenredactionType(pattern.type),
              span: { key, start: match.index, end: match.index + match[0]!.length },
              confidence: 'HIGH',
              evidence: [`openredaction:${pattern.type}`],
              detector: meta,
            });
            recoveredTypes.add(pattern.type);
          }
        }

        // Types the library reported but pattern recovery missed (checksum-only
        // or divergent matchers): emit one finding per such detection so we
        // never silent-drop a reported hit.
        for (const det of result.detections) {
          if (recoveredTypes.has(det.type)) continue;
          findings.push({
            class: scrubClassFromOpenredactionType(det.type),
            span: { key, start: 0, end: value.length },
            confidence: 'MEDIUM',
            evidence: [`openredaction:${det.type}`, 'offset-unavailable'],
            detector: meta,
          });
        }
      }
      return findings;
    },
  };
}

/**
 * Legacy ScrubStage wrapper around {@link openredactionDetector}.
 */
export function openredactionStage(
  policy: KeyPolicy,
  detector: OpenRedactionDetector = buildDefaultDetector(),
): ScrubStage {
  const det = openredactionDetector(policy, detector);
  return {
    name: det.name,
    version: det.version,
    async scrub(attributes: Attributes) {
      const findings = await det.detect(attributes);
      return applyDispositions(attributes, findings);
    },
  };
}
