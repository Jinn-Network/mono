import { describe, expect, it } from "vitest";
import {
  compareRateTo,
  saturationAt,
  SATURATION_REFERENCE_BAND,
  SATURATION_REFERENCE_BAND_RATIO,
} from "./saturation.js";
import type { CurationRow } from "./projection.js";

const row = (num: number, den: number): CurationRow => ({
  taskDigest: `sha256:${"c".repeat(64)}`,
  bucket: "organic",
  attempts: den,
  verdicts: den,
  passRate: { num, den },
  window: { first: "2026-07-31T00:00:00Z", last: "2026-07-31T01:00:00Z" },
  inputRefs: [],
});

describe("compareRateTo", () => {
  it("compares by exact cross-multiplication", () => {
    expect(compareRateTo(row(8, 10), { num: 70, den: 100 })).toBe(1);
    expect(compareRateTo(row(7, 10), { num: 70, den: 100 })).toBe(0);
    expect(compareRateTo(row(1, 10), { num: 70, den: 100 })).toBe(-1);
  });

  it("is exact where floating point is not (1/3 vs 0.3333...)", () => {
    expect(compareRateTo(row(1, 3), { num: 3333, den: 10_000 })).toBe(1);
  });

  it("returns undefined when there are no decision-grade verdicts", () => {
    expect(compareRateTo(row(0, 0), { num: 70, den: 100 })).toBeUndefined();
  });

  it("rejects a non-positive or negative threshold rather than guessing", () => {
    expect(() => compareRateTo(row(1, 2), { num: 1, den: 0 })).toThrow(/threshold/i);
    expect(() => compareRateTo(row(1, 2), { num: -1, den: 2 })).toThrow(/threshold/i);
  });
});

describe("saturationAt", () => {
  it("is true only strictly above the supplied threshold", () => {
    expect(saturationAt(row(8, 10), { num: 70, den: 100 })).toBe(true);
    expect(saturationAt(row(7, 10), { num: 70, den: 100 })).toBe(false);
    expect(saturationAt(row(1, 10), { num: 70, den: 100 })).toBe(false);
  });

  it("is undefined, never false, when saturation is not observable", () => {
    expect(saturationAt(row(0, 0), { num: 70, den: 100 })).toBeUndefined();
  });

  it("has no default threshold -- the band is never applied silently", () => {
    expect(saturationAt.length).toBe(2);
    // @ts-expect-error the threshold argument is required
    expect(() => saturationAt(row(1, 2))).toThrow();
  });
});

describe("SATURATION_REFERENCE_BAND", () => {
  it("states the research band exactly as the design does", () => {
    expect(SATURATION_REFERENCE_BAND).toEqual({ min: 0.02, max: 0.70 });
  });

  it("agrees with the exact-ratio form the comparison consumes", () => {
    expect(SATURATION_REFERENCE_BAND_RATIO.min.num / SATURATION_REFERENCE_BAND_RATIO.min.den)
      .toBeCloseTo(SATURATION_REFERENCE_BAND.min, 10);
    expect(SATURATION_REFERENCE_BAND_RATIO.max.num / SATURATION_REFERENCE_BAND_RATIO.max.den)
      .toBeCloseTo(SATURATION_REFERENCE_BAND.max, 10);
  });

  it("is a reference, not a policy: nothing in the projector reads it", async () => {
    const projection = await import("./projection.js");
    expect(Object.keys(projection)).not.toContain("SATURATION_REFERENCE_BAND");
  });
});
