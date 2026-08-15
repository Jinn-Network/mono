import { describe, expect, test } from "vitest";
import {
  compareCalendarStrictRfc3339Instants,
  isCalendarStrictRfc3339,
} from "./rfc3339.js";

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

describe("compareCalendarStrictRfc3339Instants", () => {
  test("preserves arbitrary fractional precision instead of truncating to milliseconds", () => {
    expect(compareCalendarStrictRfc3339Instants(
      "2026-07-29T00:00:00.0001Z",
      "2026-07-29T00:00:00.0002Z",
    )).toBe(-1);
    expect(compareCalendarStrictRfc3339Instants(
      "2026-07-29T00:00:00.1Z",
      "2026-07-29T00:00:00.10Z",
    )).toBe(0);
  });

  test("compares equal instants written with distinct numeric offsets as equal", () => {
    expect(compareCalendarStrictRfc3339Instants(
      "2026-07-29T02:30:00.123400+02:30",
      "2026-07-29T00:00:00.1234Z",
    )).toBe(0);
  });

  test("orders a calendar-valid leap second before the following civil second", () => {
    expect(compareCalendarStrictRfc3339Instants(
      "2016-12-31T23:59:60.999999Z",
      "2017-01-01T00:00:00Z",
    )).toBe(-1);
    expect(compareCalendarStrictRfc3339Instants(
      "2017-01-01T00:59:60.25+01:00",
      "2016-12-31T23:59:60.250Z",
    )).toBe(0);
  });

  test("refuses malformed and impossible civil inputs instead of normalizing them", () => {
    expect(compareCalendarStrictRfc3339Instants(
      "2026-02-30T00:00:00Z",
      "2026-03-02T00:00:00Z",
    )).toBeUndefined();
    expect(compareCalendarStrictRfc3339Instants(
      "2026-03-02T00:00:00Z",
      "not-a-time",
    )).toBeUndefined();
  });
});
