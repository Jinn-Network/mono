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

  it("refuses a non-string", () => {
    expect(isHeadTimestamp(undefined)).toBe(false);
    expect(isHeadTimestamp(1_767_225_600_000)).toBe(false);
  });
});
