import { describe, expect, test } from "vitest";
import { toCalendarStrictRfc3339 } from "./rfc3339-from-source.js";

describe("toCalendarStrictRfc3339", () => {
  test("passes through an already-strict instant unchanged", () => {
    expect(toCalendarStrictRfc3339("2026-03-09T12:34:56Z")).toBe("2026-03-09T12:34:56Z");
    expect(toCalendarStrictRfc3339("2026-03-09T12:34:56+02:00")).toBe("2026-03-09T12:34:56+02:00");
  });

  test("promotes a bare calendar date to midnight UTC", () => {
    expect(toCalendarStrictRfc3339("2026-03-09")).toBe("2026-03-09T00:00:00Z");
  });

  test("repairs a space-separated timestamp", () => {
    expect(toCalendarStrictRfc3339("2026-03-09 12:34:56")).toBe("2026-03-09T12:34:56Z");
  });

  test("refuses anything it cannot convert explicitly, rather than guessing", () => {
    // A lenient Date-based coercion is exactly what the rfc3339 module warns against inheriting.
    // `2026-02-30` is the load-bearing case: `new Date()` would silently normalize it to March 2nd
    // and produce a valid-looking timestamp that is simply wrong, which nothing downstream catches.
    expect(() => toCalendarStrictRfc3339("not-a-date")).toThrow(/cannot be converted/u);
    expect(() => toCalendarStrictRfc3339("2026-02-30")).toThrow(/cannot be converted/u);
    expect(() => toCalendarStrictRfc3339("1772000000")).toThrow(/cannot be converted/u);
    expect(() => toCalendarStrictRfc3339("")).toThrow(/cannot be converted/u);
  });
});
