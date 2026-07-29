import { describe, expect, test } from "vitest";
import {
  compareCalendarStrictRfc3339Instants,
  isCalendarStrictRfc3339,
} from "./rfc3339.js";

describe("trust-local calendar-strict RFC 3339 authority times", () => {
  test.each([
    "2016-12-31T23:59:60Z",
    "2017-01-01T00:59:60+01:00",
    "2026-07-29T00:00:00.123456789123456789Z",
  ])("accepts valid authority time %s", (value) => {
    expect(isCalendarStrictRfc3339(value)).toBe(true);
  });

  test.each([
    "2016-12-30T23:59:60Z",
    "2026-02-30T00:00:00Z",
    "2026-01-01T00:00:00+24:00",
  ])("rejects malformed authority time %s", (value) => {
    expect(isCalendarStrictRfc3339(value)).toBe(false);
  });

  test("compares equivalent offsets and arbitrary fractional tails exactly", () => {
    expect(compareCalendarStrictRfc3339Instants(
      "2026-07-29T02:00:00.100000000000000001+02:00",
      "2026-07-29T00:00:00.100000000000000001Z",
    )).toBe(0);
    expect(compareCalendarStrictRfc3339Instants(
      "2026-07-29T00:00:00.100000000000000001Z",
      "2026-07-29T00:00:00.100000000000000002Z",
    )).toBe(-1);
  });

  test("orders the lexically later +02:00 revocation before the UTC evidence instant", () => {
    expect(compareCalendarStrictRfc3339Instants(
      "2026-07-29T01:00:00+02:00",
      "2026-07-29T00:00:00Z",
    )).toBe(-1);
  });
});
