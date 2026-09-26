import { describe, it, expect } from "vitest";
import { MAX_REFRESH_BY_AHEAD_MS, checkRefreshWindow, refreshByWithinCeiling } from "./refresh-bound.js";

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

describe("checkRefreshWindow (§5.2 as a whole, #3467)", () => {
  const NOW = new Date("2026-07-28T00:00:00.000Z");

  it("accepts a conformant window issued at the consumer's own clock", () => {
    expect(checkRefreshWindow({ issuedAt: "2026-07-28T00:00:00.000Z", refreshBy: "2026-07-29T00:00:00.000Z" }, NOW)).toBeUndefined();
  });

  it("refuses a window wider than the ceiling", () => {
    expect(checkRefreshWindow({ issuedAt: "2026-07-28T00:00:00.000Z", refreshBy: "2030-01-01T00:00:00.000Z" }, NOW)).toBe("refresh-by-ceiling");
  });

  it("refuses an empty or inverted window, the shape the writing side already refuses to mint", () => {
    expect(checkRefreshWindow({ issuedAt: "2026-07-28T00:00:00.000Z", refreshBy: "2026-07-28T00:00:00.000Z" }, NOW)).toBe("refresh-by-ceiling");
    expect(checkRefreshWindow({ issuedAt: "2099-01-01T00:00:00.000Z", refreshBy: "2098-01-01T00:00:00.000Z" }, NOW)).toBe("refresh-by-ceiling");
  });

  it("refuses a head issued further into the future than one freshness window", () => {
    // The ceiling alone cannot see this: both timestamps are the source's to
    // choose, so a 24h-conformant window in 2099 passes it and then stays
    // fresh for decades -- and on first adoption becomes the high-water mark
    // that refuses every honest head after it.
    expect(checkRefreshWindow({ issuedAt: "2099-01-01T00:00:00.000Z", refreshBy: "2099-01-02T00:00:00.000Z" }, NOW)).toBe("head-issued-ahead");
  });

  it("tolerates a consumer clock trailing the source by up to one window", () => {
    // A live source issues at its own `now`; the allowance exists for clock
    // disagreement, and one window is far more than any real skew needs.
    expect(checkRefreshWindow({ issuedAt: "2026-07-28T23:00:00.000Z", refreshBy: "2026-07-29T12:00:00.000Z" }, NOW)).toBeUndefined();
    expect(checkRefreshWindow({ issuedAt: "2026-07-29T01:00:00.000Z", refreshBy: "2026-07-29T12:00:00.000Z" }, NOW)).toBe("head-issued-ahead");
  });

  it("accepts a head issued in the past, however long ago -- expiry is freshness's job, not the window's", () => {
    expect(checkRefreshWindow({ issuedAt: "2020-01-01T00:00:00.000Z", refreshBy: "2020-01-02T00:00:00.000Z" }, NOW)).toBeUndefined();
  });

  it("clamps a caller-supplied ceiling: a profile may only tighten, never widen", () => {
    const wide = { issuedAt: "2026-07-28T00:00:00.000Z", refreshBy: "2030-01-01T00:00:00.000Z" };
    expect(checkRefreshWindow(wide, NOW, 4 * 365 * 24 * 60 * 60 * 1000)).toBe("refresh-by-ceiling");
    const inside = { issuedAt: "2026-07-28T00:00:00.000Z", refreshBy: "2026-07-28T12:00:00.000Z" };
    expect(checkRefreshWindow(inside, NOW)).toBeUndefined();
    expect(checkRefreshWindow(inside, NOW, 60 * 60 * 1000)).toBe("refresh-by-ceiling");
  });

  it("fails closed on timestamps it cannot compare", () => {
    expect(checkRefreshWindow({ issuedAt: "not-a-timestamp", refreshBy: "2026-07-29T00:00:00.000Z" }, NOW)).toBe("refresh-by-ceiling");
    expect(checkRefreshWindow({ issuedAt: "2026-07-28T00:00:00.000Z", refreshBy: "not-a-timestamp" }, NOW)).toBe("refresh-by-ceiling");
  });

  it("fails closed on a nonsensical ceiling rather than widening on one", () => {
    const head = { issuedAt: "2026-07-28T00:00:00.000Z", refreshBy: "2026-07-28T12:00:00.000Z" };
    expect(checkRefreshWindow(head, NOW, Number.NaN)).toBe("refresh-by-ceiling");
    expect(checkRefreshWindow(head, NOW, -1)).toBe("refresh-by-ceiling");
    expect(checkRefreshWindow(head, NOW, Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});

describe("offset-less head timestamps (§5.2, #3482)", () => {
  const NOW = new Date("2026-07-28T00:00:00.000Z");

  // Two spacings, because one cannot carry the regression on its own: before
  // the fix the offset-less `issuedAt` was read as host-local, so whether a
  // single pair landed inside the 24h ceiling depended on the runner's zone.
  // A 6h and a 20h window between them are acceptable pre-fix in every real
  // zone (UTC-12 through UTC+14), so at least one of these assertions fails
  // wherever the suite runs.
  it("refuses an offset-less `issuedAt` rather than reading it as host-local time", () => {
    for (const refreshBy of ["2026-07-28T06:00:00.000Z", "2026-07-28T20:00:00.000Z"]) {
      expect(refreshByWithinCeiling({ issuedAt: "2026-07-28T00:00:00", refreshBy })).toBe(false);
      expect(checkRefreshWindow({ issuedAt: "2026-07-28T00:00:00", refreshBy }, NOW)).toBe("refresh-by-ceiling");
    }
  });

  it("refuses an offset-less `refreshBy` the same way", () => {
    for (const issuedAt of ["2026-07-28T18:00:00.000Z", "2026-07-28T04:00:00.000Z"]) {
      expect(refreshByWithinCeiling({ issuedAt, refreshBy: "2026-07-29T00:00:00" })).toBe(false);
      expect(checkRefreshWindow({ issuedAt, refreshBy: "2026-07-29T00:00:00" }, NOW)).toBe("refresh-by-ceiling");
    }
  });

  it("reads an offset-bearing window as the instant it names, wherever the consumer sits", () => {
    expect(checkRefreshWindow({ issuedAt: "2026-07-28T02:00:00+02:00", refreshBy: "2026-07-29T02:00:00+02:00" }, NOW)).toBeUndefined();
  });
});
