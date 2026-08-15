import { describe, expect, test } from "vitest";
import { crossCheckCensorship } from "./censorship-crosscheck.js";

describe("crossCheckCensorship", () => {
  test("flags the exact missing floor when announced open Submissions trail TaskCreated", () => {
    expect(
      crossCheckCensorship(new Set(["submission-1"]), 3),
    ).toEqual({ consistent: false, missing: 2 });
  });

  test("is consistent at or above the finalized on-chain count and never returns a negative missing count", () => {
    expect(
      crossCheckCensorship(new Set(["submission-1", "submission-2"]), 2),
    ).toEqual({ consistent: true, missing: 0 });
    expect(
      crossCheckCensorship(new Set(["submission-1", "submission-2", "submission-3"]), 2),
    ).toEqual({ consistent: true, missing: 0 });
  });

  test("rejects invalid chain counts instead of silently rounding", () => {
    expect(() => crossCheckCensorship(new Set(), -1)).toThrow(/non-negative safe integer/);
    expect(() => crossCheckCensorship(new Set(), 1.5)).toThrow(/non-negative safe integer/);
  });
});
