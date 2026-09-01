// The published-source profile's `refreshBy` ceiling (design §5.2), in the
// one place both named verification procedures and the serving side can
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
// Deployment profiles pin their own, TIGHTER bound (the marketplace profile
// does); a profile may never widen it. That is why the checking functions
// take the ceiling as a parameter defaulting to the published-source value
// rather than reading a constant directly.

/** §5.2's published-source-profile default bound: `refreshBy` at most 24h ahead of `issuedAt`. */
export const MAX_REFRESH_BY_AHEAD_MS = 24 * 60 * 60 * 1000;

/**
 * Whether `head.refreshBy` sits at most `maxAheadMs` ahead of `head.issuedAt`.
 *
 * Fail-closed on anything it cannot compare: an unparseable `issuedAt` or
 * `refreshBy` makes the difference `NaN`, and `NaN <= n` is `false`, so a head
 * whose timestamps cannot be read is refused rather than waved through.
 */
export function refreshByWithinCeiling(
  head: { issuedAt: string; refreshBy: string },
  maxAheadMs: number = MAX_REFRESH_BY_AHEAD_MS,
): boolean {
  const aheadMs = new Date(head.refreshBy).getTime() - new Date(head.issuedAt).getTime();
  return aheadMs <= maxAheadMs;
}
