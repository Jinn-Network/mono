import { isCalendarStrictRfc3339 } from "@jinn-network/benchmarking-records";

/**
 * Converts an upstream dataset timestamp into the calendar-strict RFC 3339 form that
 * `resolveBenchmarkTaskProvenance` requires, using explicit shape repairs only.
 *
 * Upstream datasets are inconsistent: some rows carry a full instant (`2026-03-09T12:34:56Z`),
 * some a bare calendar date (`2026-03-09`), some a space-separated pandas/CSV rendering
 * (`2026-03-09 12:34:56`). Only the first is already acceptable.
 *
 * This deliberately never routes through `Date` parsing. A lenient parser silently normalizes
 * impossible dates — `2026-02-30` becomes March 2nd — producing a wrong-but-valid timestamp that
 * would degrade contamination accounting without ever raising. Refusing is the correct outcome for
 * anything not explicitly recognized here.
 */
export function toCalendarStrictRfc3339(value: string): string {
  const candidates = [
    value,
    /^\d{4}-\d{2}-\d{2}$/u.test(value) ? `${value}T00:00:00Z` : undefined,
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(value) ? `${value.replace(" ", "T")}Z` : undefined,
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined && isCalendarStrictRfc3339(candidate)) return candidate;
  }
  throw new Error(`timestamp ${JSON.stringify(value)} cannot be converted to calendar-strict RFC 3339`);
}
