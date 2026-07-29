import { describe, expect, test } from "vitest";
import { isCalendarStrictRfc3339 } from "./rfc3339.js";

describe("isCalendarStrictRfc3339", () => {
  test.each([
    "2024-02-29T23:59:59Z",
    "2026-07-29T00:00:00.123456789+02:30",
    "2026-01-01T00:00:00-00:00",
    "2016-12-31T23:59:60Z",
    "2017-01-01T00:59:60+01:00",
  ])("accepts a calendar-valid RFC 3339 instant without rewriting it: %s", (value) => {
    expect(isCalendarStrictRfc3339(value)).toBe(true);
  });

  test.each([
    "2026-02-30T00:00:00Z",
    "2025-02-29T00:00:00Z",
    "2026-13-01T00:00:00Z",
    "2026-01-01T24:00:00Z",
    "2026-01-01T00:60:00Z",
    "2026-01-01T00:00:61Z",
    "2026-01-01T00:00:60Z",
    "2026-01-01T00:00:00+24:00",
    "0000-01-01T00:00:00Z",
    "2026-01-01 00:00:00Z",
  ])("rejects an impossible civil instant or an out-of-grammar component: %s", (value) => {
    expect(isCalendarStrictRfc3339(value)).toBe(false);
  });

  test("rejects non-string values", () => {
    expect(isCalendarStrictRfc3339(undefined)).toBe(false);
    expect(isCalendarStrictRfc3339(1)).toBe(false);
  });
});
