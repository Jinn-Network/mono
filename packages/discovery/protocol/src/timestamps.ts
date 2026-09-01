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
// One helper, not a regex per call site: the schema (`parseSourceHead`) and
// every §5.2 comparison in this package and in `serve` go through it, so a
// head object that reached a verifier without passing the schema still fails
// closed instead of being read host-locally.

/** Splits a validated RFC 3339 date-time into the parts `Date.parse` needs pinned. */
const VALIDATED_SHAPE = /^(.{17})(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/u;

/**
 * The instant `value` names, in milliseconds since the epoch, or `NaN` when it
 * is not a calendar-strict, offset-bearing RFC 3339 date-time.
 *
 * `NaN` is the deliberate failure shape: every comparison against it is
 * `false`, so callers that already fail closed on an unreadable timestamp
 * (the §5.2 window checks do) keep doing so without a second code path.
 *
 * Sub-millisecond precision is truncated, and a leap second is reported as the
 * instant one millisecond after 23:59:59.000 -- both are the same collapse
 * trust-core's own instant comparison applies, and neither can reorder two
 * timestamps a millisecond-granular window bound could tell apart.
 */
export function parseHeadTimestamp(value: unknown): number {
  if (!isCalendarStrictRfc3339(value)) return Number.NaN;
  const parts = VALIDATED_SHAPE.exec(value);
  if (parts === null) return Number.NaN;
  const [, upToSeconds, second, fraction, offset] = parts;
  const isLeapSecond = second === "60";
  const milliseconds = (fraction ?? "").slice(0, 3).padEnd(3, "0");
  const parsed = Date.parse(`${upToSeconds}${isLeapSecond ? "59" : second}.${milliseconds}${offset}`);
  return isLeapSecond ? parsed + 1 : parsed;
}

/** Whether `value` is a calendar-strict, offset-bearing RFC 3339 date-time (§5.2). */
export function isHeadTimestamp(value: unknown): boolean {
  return !Number.isNaN(parseHeadTimestamp(value));
}
