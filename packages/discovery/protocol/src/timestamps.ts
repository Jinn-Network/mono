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
// The fix is to make the instant unambiguous before anything compares it: a
// head timestamp is ISO-8601 extended date-time WITH an explicit offset, "Z"
// or "+/-HH:MM". That is exactly the subset ECMAScript pins in its own Date
// Time String Format, so every conforming engine reads it as the same instant.
// Lowercase "t"/"z" is permitted by RFC 3339's own note but sits outside that
// pinned subset, so it is refused rather than left to the host's fallback
// parser -- the point here is determinism, not maximal acceptance.
//
// One helper, not a regex per call site: the schema (`parseSourceHead`) and
// every comparison that reads these fields (`refresh-bound`, the chain
// procedure's `issuedAt` monotonicity) go through it, so a head object that
// reached a verifier without passing the schema still fails closed instead of
// being read host-locally.

/**
 * ISO-8601 extended date-time with a mandatory, explicit UTC offset. Shape
 * only -- component ranges are left to `Date.parse`, which applies the
 * spec's own bounds (month 13, offset +30:00 and second 60 are all NaN).
 */
const HEAD_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

/**
 * The instant `value` names, in milliseconds since the epoch, or `NaN` when
 * it is not an offset-bearing ISO-8601 date-time.
 *
 * `NaN` is the deliberate failure shape: every comparison against it is
 * `false`, so callers that already fail closed on an unreadable timestamp
 * (the §5.2 window checks do) keep doing so without a second code path.
 */
export function parseHeadTimestamp(value: unknown): number {
  if (typeof value !== "string" || !HEAD_TIMESTAMP.test(value)) return Number.NaN;
  return Date.parse(value);
}

/** Whether `value` is an offset-bearing ISO-8601 date-time (§5.2). */
export function isHeadTimestamp(value: unknown): boolean {
  return !Number.isNaN(parseHeadTimestamp(value));
}
