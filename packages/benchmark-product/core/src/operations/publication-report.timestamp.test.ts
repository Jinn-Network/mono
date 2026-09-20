import { describe, expect, it } from "vitest";
import { BenchmarkProductError } from "../errors.js";
import { timestampAfter } from "./publication-report-timestamp.js";

describe("timestampAfter (#4304)", () => {
  const clockAt = "2026-08-13T00:00:00.000Z";

  it("advances a leap-second prior issuedAt instead of throwing RangeError", () => {
    expect(timestampAfter(clockAt, "2026-06-30T23:59:60Z")).toBe("2026-08-13T00:00:00.000Z");
  });

  it("refuses an unreadable prior issuedAt with a typed error, not RangeError", () => {
    expect(() => timestampAfter(clockAt, "2026-06-30T23:59:60")).toThrow(BenchmarkProductError);
    try {
      timestampAfter(clockAt, "August 13, 2026");
      throw new Error("expected refusal");
    } catch (cause) {
      expect(cause).toBeInstanceOf(BenchmarkProductError);
      expect(cause).not.toBeInstanceOf(RangeError);
    }
  });

  it("still chooses the later of clock and prior+1ms", () => {
    expect(timestampAfter("2026-08-13T00:00:00.000Z", "2026-08-13T00:00:00.000Z")).toBe(
      "2026-08-13T00:00:00.001Z",
    );
  });
});
