import { describe, it, expect } from "vitest";
import { MAX_REFRESH_BY_AHEAD_MS, refreshByWithinCeiling } from "./refresh-bound.js";

describe("refreshByWithinCeiling (§5.2, #3467)", () => {
  it("pins the published-source profile's default bound at 24 hours", () => {
    expect(MAX_REFRESH_BY_AHEAD_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("accepts a refreshBy inside the ceiling", () => {
    expect(refreshByWithinCeiling({ issuedAt: "2026-07-28T00:00:00.000Z", refreshBy: "2026-07-28T23:00:00.000Z" })).toBe(true);
  });

  it("accepts a refreshBy exactly on the ceiling", () => {
    expect(refreshByWithinCeiling({ issuedAt: "2026-07-28T00:00:00.000Z", refreshBy: "2026-07-29T00:00:00.000Z" })).toBe(true);
  });

  it("refuses a refreshBy one millisecond past the ceiling", () => {
    expect(refreshByWithinCeiling({ issuedAt: "2026-07-28T00:00:00.000Z", refreshBy: "2026-07-29T00:00:00.001Z" })).toBe(false);
  });

  it("refuses a far-future refreshBy -- the shape no clock comparison can catch", () => {
    expect(refreshByWithinCeiling({ issuedAt: "2026-07-28T00:00:00.000Z", refreshBy: "2030-01-01T00:00:00.000Z" })).toBe(false);
  });

  it("honors a tighter caller-supplied ceiling, and only tightening changes the answer", () => {
    const head = { issuedAt: "2026-07-28T00:00:00.000Z", refreshBy: "2026-07-28T12:00:00.000Z" };
    expect(refreshByWithinCeiling(head)).toBe(true);
    expect(refreshByWithinCeiling(head, 60 * 60 * 1000)).toBe(false);
  });

  it("fails closed on timestamps it cannot compare", () => {
    expect(refreshByWithinCeiling({ issuedAt: "not-a-timestamp", refreshBy: "2026-07-29T00:00:00.000Z" })).toBe(false);
    expect(refreshByWithinCeiling({ issuedAt: "2026-07-28T00:00:00.000Z", refreshBy: "not-a-timestamp" })).toBe(false);
  });
});
