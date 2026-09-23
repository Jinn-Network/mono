import { describe, it, expect } from "vitest";
import { isHeadTimestamp, parseHeadTimestamp } from "./timestamps.js";

describe("parseHeadTimestamp (§5.2 head timestamps, #3482)", () => {
  it("accepts a UTC-designated instant", () => {
    expect(parseHeadTimestamp("2026-07-28T00:00:00Z")).toBe(Date.UTC(2026, 6, 28));
  });

  it("accepts fractional seconds", () => {
    expect(parseHeadTimestamp("2026-07-28T00:00:00.250Z")).toBe(Date.UTC(2026, 6, 28) + 250);
  });

  it("accepts a numeric offset and resolves it to the same instant as its UTC spelling", () => {
    expect(parseHeadTimestamp("2026-07-28T02:00:00+02:00")).toBe(parseHeadTimestamp("2026-07-28T00:00:00Z"));
    expect(parseHeadTimestamp("2026-07-27T22:00:00-02:00")).toBe(parseHeadTimestamp("2026-07-28T00:00:00Z"));
  });

  it("refuses an offset-less instant -- the host-local reading is the whole defect", () => {
    expect(parseHeadTimestamp("2026-07-28T00:00:00")).toBeNaN();
    expect(isHeadTimestamp("2026-07-28T00:00:00")).toBe(false);
  });

  it("refuses a date without a time, a lowercase designator, and a non-timestamp", () => {
    expect(parseHeadTimestamp("2026-07-28")).toBeNaN();
    expect(parseHeadTimestamp("2026-07-28t00:00:00z")).toBeNaN();
    expect(parseHeadTimestamp("not-a-timestamp")).toBeNaN();
    expect(parseHeadTimestamp("")).toBeNaN();
  });

  it("refuses the legacy non-ISO spellings host Date parsers accept at their own discretion", () => {
    expect(parseHeadTimestamp("Tue Jul 28 2026 00:00:00 GMT+0000")).toBeNaN();
    expect(parseHeadTimestamp("July 28, 2026")).toBeNaN();
  });

  it("refuses an out-of-range component or offset even though the shape matches", () => {
    expect(parseHeadTimestamp("2026-13-01T00:00:00Z")).toBeNaN();
    expect(parseHeadTimestamp("2026-07-28T00:00:00+30:00")).toBeNaN();
  });

  it("refuses a day the calendar does not have, which a bare Date.parse rolls forward instead", () => {
    expect(parseHeadTimestamp("2026-02-30T00:00:00Z")).toBeNaN();
    expect(Number.isNaN(Date.parse("2026-02-30T00:00:00Z"))).toBe(false);
  });

  it("orders a leap second after every millisecond of the second it follows and before the next day", () => {
    const leap = parseHeadTimestamp("2026-06-30T23:59:60Z");
    expect(leap).toBeGreaterThan(parseHeadTimestamp("2026-06-30T23:59:59.998Z"));
    expect(leap).toBeLessThan(parseHeadTimestamp("2026-07-01T00:00:00Z"));
  });

  it("collapses two leap-second spellings onto one value, so a strict `>` rule refuses rather than admits", () => {
    expect(parseHeadTimestamp("2026-06-30T23:59:60.500Z")).toBe(parseHeadTimestamp("2026-06-30T23:59:60.000Z"));
  });

  it("refuses a second 60 that is not a real leap boundary", () => {
    expect(parseHeadTimestamp("2026-07-28T23:59:60Z")).toBeNaN();
  });

  it("truncates sub-millisecond precision rather than handing an unpinned spelling to the engine", () => {
    expect(parseHeadTimestamp("2026-07-28T00:00:00.1Z")).toBe(Date.UTC(2026, 6, 28) + 100);
    expect(parseHeadTimestamp("2026-07-28T00:00:00.123999Z")).toBe(Date.UTC(2026, 6, 28) + 123);
  });

  it("refuses a non-string", () => {
    expect(isHeadTimestamp(undefined)).toBe(false);
    expect(isHeadTimestamp(1_767_225_600_000)).toBe(false);
  });
});
