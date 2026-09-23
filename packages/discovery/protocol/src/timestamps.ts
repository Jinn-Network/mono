import { isCalendarStrictRfc3339 } from "@jinn-network/trust-core";

// The one strict reading of a Source Head's `issuedAt` / `refreshBy` (§5.2).
//
// Both fields were typed as any non-empty string and read back through bare
// `new Date(...)`, which is two different problems at once. Outside the ISO
// grammar the host parser is free to do whatever it likes, and INSIDE the
// grammar an offset-less spelling ("2026-07-28T00:00:00") is defined to mean
// host-LOCAL time. So one signed head presented a ~23h window to a UTC+14
// consumer and a ~48h one to a UTC-11 consumer: up to +/-14h of the profile's
// own allowance consumed by parsing, and -- since #3467 turned the window
// into a typed refusal -- the same signed bytes accepted on one host and
// refused on another. Consensus divergence, not a widened window.
//
// Validity is trust-core's `isCalendarStrictRfc3339`, not a second regex: the
// repository already owns one calendar-strict RFC 3339 reading (offset
// mandatory, real month lengths, leap seconds only at a true boundary), and
// protocol already depends on trust-core. A private grammar here would be a
// second answer to the same question -- and a laxer one, since a bare
// `Date.parse` silently rolls "2026-02-30" forward to March.
//
// What trust-core does not offer is a millisecond value, which the §5.2
// ceiling arithmetic needs, so this module supplies exactly that and nothing
// else. It reaches `Date.parse` only after narrowing the validated string to
// the spelling ECMAScript pins in its Date Time String Format -- three
// fraction digits, seconds at most 59 -- so no accepted head is ever handed
// to an engine's implementation-defined fallback.
//
// One helper, not a regex per call site: the schema (`parseSourceHead`), the
// §5.2 window checks, the chain procedure's `issuedAt` monotonicity, and
// `serve`'s head maintenance and durable writer all go through it, so a head
// object that reached one of them without passing the schema still fails
// closed instead of being read host-locally. A `FreshnessPolicy` is a
// consumer-supplied port and is not covered; both verification procedures run
// the window check, which is covered, before they consult it.

/**
 * Splits an already-validated RFC 3339 date-time into the parts `Date.parse`
 * needs pinned. It restates the grammar rather than indexing into it, so a
 * future edit to trust-core's own pattern cannot silently misalign the split;
 * a string this fails to match is refused (`NaN`) rather than guessed at.
 */
const VALIDATED_SHAPE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:)(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/u;

/**
 * The instant `value` names, in milliseconds since the epoch, or `NaN` when it
 * is not a calendar-strict, offset-bearing RFC 3339 date-time.
 *
 * `NaN` is the deliberate failure shape: every comparison against it is
 * `false`, so callers that already fail closed on an unreadable timestamp
 * (the §5.2 window checks do) keep doing so without a second code path.
 *
 * Sub-millisecond precision is truncated, so two timestamps that differ only
 * below the millisecond collapse to one value -- again the fail-closed side of
 * a strict `>`, and finer than any bound §5.2 expresses. This is a narrower
 * reading than trust-core's own `compareCalendarStrictRfc3339Instants`, which
 * compares fractions exactly; nothing here needs that resolution, and only
 * this module needs a number at all.
 *
 * A leap second has no millisecond
 * representation at all -- 23:59:60 sits between 23:59:59.999 and the next
 * day's 00:00:00.000 -- so it is reported as 23:59:59.999, the last instant
 * that orders correctly against both neighbours. Every leap-second spelling
 * therefore collapses onto that one value, and onto `23:59:59.999` with it, so
 * a monotonicity rule comparing two of them with a strict `>` refuses rather
 * than accepting the later one; that is the fail-closed side, and no
 * `toISOString` producer emits a leap second in the first place.
 */
export function parseHeadTimestamp(value: unknown): number {
  if (!isCalendarStrictRfc3339(value)) return Number.NaN;
  const parts = VALIDATED_SHAPE.exec(value);
  if (parts === null) return Number.NaN;
  const [, upToSeconds, second, fraction, offset] = parts;
  const isLeapSecond = second === "60";
  const milliseconds = isLeapSecond ? "999" : (fraction ?? "").slice(0, 3).padEnd(3, "0");
  return Date.parse(`${upToSeconds}${isLeapSecond ? "59" : second}.${milliseconds}${offset}`);
}

/** Whether `value` is a calendar-strict, offset-bearing RFC 3339 date-time (§5.2). */
export function isHeadTimestamp(value: unknown): boolean {
  return !Number.isNaN(parseHeadTimestamp(value));
}
