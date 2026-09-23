// The published-source profile's head freshness-window rules (design §5.2), in
// the one place both named verification procedures and the serving side can
// reach.
//
// §5.2 bounds how far ahead of its own `issuedAt` a head may set `refreshBy`
// -- design default: 24 hours -- because, as §14.1 states plainly, that
// window IS the rollback-exposure window for a consumer without a high-water
// mark. A head that sets `refreshBy` years out is therefore not merely
// impolite: it is permanently "live" to every consumer, and `isFresh` --
// which is a real comparison against a freshly read clock -- keeps returning
// true forever. Enforcing the bound on the writing side alone leaves that
// door open to a source that mints its own heads, which is every source.
//
// A ceiling measured only between the head's OWN two timestamps does not
// close that door on its own, because both of them are the source's to
// choose: a head issued in 2099 with a conformant 24h window passes the
// ceiling and stays fresh for decades, and on first adoption (or the §13.3
// cold mirror-set comparison, which prefers the highest `(sequence,
// issuedAt)`) it also becomes the consumer's high-water mark and refuses
// every honest head after it. So the window is checked as a whole, against
// the consumer's own clock:
//
//   1. `refreshBy` must be strictly after `issuedAt` -- a head with an empty
//      or inverted window is one `serve` already refuses to write
//      (`source-writer.ts`), and a consumer that accepts it is accepting a
//      shape no conforming source produces;
//   2. `refreshBy` at most `maxAheadMs` past `issuedAt` (§5.2 proper);
//   3. `issuedAt` at most `maxAheadMs` past `now`. A head is not issued
//      further into the future than one freshness window is long. This
//      introduces no second constant and no second knob -- it reuses the
//      profile's own ceiling as the skew allowance, which is orders of
//      magnitude more tolerance than any real clock disagreement needs and
//      far less than an honest source would ever consume, since a live
//      source issues at its own `now`. Together the three bound a valid
//      head's `refreshBy` to at most `2 x maxAheadMs` past the consumer's
//      clock: finite, which is the property §5.2 is after.
//
// Deployment profiles pin their own, TIGHTER bound (the marketplace profile
// does); a profile may never widen it. The verification procedures therefore
// clamp what they are handed against the published-source value, so a caller
// cannot re-open the window by passing a larger number.

import { parseHeadTimestamp } from "../timestamps.js";

/** §5.2's published-source-profile default bound: `refreshBy` at most 24h ahead of `issuedAt`. */
export const MAX_REFRESH_BY_AHEAD_MS = 24 * 60 * 60 * 1000;

/**
 * Why a head's freshness window is not acceptable under the verifying
 * profile, or `undefined` when it is. The slugs are shared by both named
 * verification procedures so one defect reads the same either side.
 */
export type RefreshWindowFailure = "refresh-by-ceiling" | "head-issued-ahead";

/**
 * Whether `head.refreshBy` sits at most `maxAheadMs` ahead of `head.issuedAt`.
 *
 * Fail-closed on anything it cannot compare: a timestamp that is not an
 * offset-bearing ISO-8601 date-time (§5.2, #3482) makes the difference `NaN`,
 * and `NaN <= n` is `false`, so a head whose timestamps cannot be read the
 * same way on every host is refused rather than waved through.
 *
 * This is the §5.2 ceiling alone. Consumers want `checkRefreshWindow`, which
 * also rejects the inverted and future-issued shapes the ceiling by itself
 * cannot see; `serve`'s writing side wants this one, because it checks those
 * shapes separately and against its own intended position.
 */
export function refreshByWithinCeiling(
  head: { issuedAt: string; refreshBy: string },
  maxAheadMs: number = MAX_REFRESH_BY_AHEAD_MS,
): boolean {
  const aheadMs = parseHeadTimestamp(head.refreshBy) - parseHeadTimestamp(head.issuedAt);
  return aheadMs <= maxAheadMs;
}

/**
 * The whole §5.2 freshness-window check a consumer applies to a presented
 * head, per the three rules above. Returns the first rule violated, or
 * `undefined` when the window is acceptable.
 *
 * `maxAheadMs` is clamped against the published-source ceiling: a deployment
 * profile may only tighten the bound, never widen it, and this is where that
 * sentence is enforced rather than merely documented. `Infinity` therefore
 * clamps to the published ceiling rather than widening; `NaN` and negatives
 * fail closed on their own, because every comparison below goes false.
 *
 * Note that rule 3 reuses `ceilingMs` as the clock-skew allowance, so a
 * profile that pins a very tight ceiling pins an equally tight skew tolerance
 * for every head it verifies. That coupling is intentional -- the allowance
 * should shrink with the window it protects, and one parameter is better than
 * two -- but a profile author choosing a ceiling is choosing both.
 */
export function checkRefreshWindow(
  head: { issuedAt: string; refreshBy: string },
  now: Date,
  maxAheadMs: number = MAX_REFRESH_BY_AHEAD_MS,
): RefreshWindowFailure | undefined {
  // A timestamp that is not an offset-bearing RFC 3339 date-time (§5.2,
  // #3482) parses to `NaN`, every comparison below goes false, and the head is
  // refused as `refresh-by-ceiling`. The slug names the rule, not the cause --
  // the grammar failure is caught with its own message at `parseSourceHead`,
  // and reaching here means a caller built the head without the schema.
  const ceilingMs = Math.min(maxAheadMs, MAX_REFRESH_BY_AHEAD_MS);
  const issuedAtMs = parseHeadTimestamp(head.issuedAt);
  const refreshByMs = parseHeadTimestamp(head.refreshBy);
  if (!(refreshByMs > issuedAtMs)) return "refresh-by-ceiling";
  if (!(refreshByMs - issuedAtMs <= ceilingMs)) return "refresh-by-ceiling";
  if (!(issuedAtMs - now.getTime() <= ceilingMs)) return "head-issued-ahead";
  return undefined;
}
