import { describe, expect, test } from "vitest";
import { wilsonInterval } from "@jinn-network/benchmarking-aggregate";
import {
  expectedIntervalWidth,
  formatSampleSizeAdvisory,
  sampleSizeAdvisory,
} from "./sample-size-advisory.js";

describe("expectedIntervalWidth", () => {
  test("is the width of the shipped Wilson interval at p = 0.5, not a second implementation", () => {
    for (const n of [1, 3, 24, 500]) {
      const { lo, hi } = wilsonInterval(n / 2, n);
      expect(expectedIntervalWidth(n)).toBe((hi - lo).toFixed(4));
    }
  });

  test("narrows monotonically in n and never exceeds the unit interval", () => {
    let previous = Number.POSITIVE_INFINITY;
    for (const n of [1, 2, 3, 6, 12, 24, 48, 100, 500]) {
      const value = Number(expectedIntervalWidth(n));
      expect(value).toBeLessThan(previous);
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThanOrEqual(1);
      previous = value;
    }
  });

  test("is the canonical 4-decimal spelling every sealed interval uses", () => {
    expect(expectedIntervalWidth(24)).toMatch(/^\d\.\d{4}$/);
  });

  test("refuses a sample size no run can have rather than printing a meaningless width", () => {
    for (const n of [0, -1, 2.5, Number.NaN]) {
      expect(() => expectedIntervalWidth(n)).toThrow(RangeError);
    }
  });
});

describe("sampleSizeAdvisory", () => {
  test("n is the per-arm scorable trial count: items x replicates", () => {
    expect(sampleSizeAdvisory({ items: 12, replicates: 2 }).n).toBe(24);
    expect(sampleSizeAdvisory({ items: 12, replicates: 2 }).expectedIntervalWidth)
      .toBe(expectedIntervalWidth(24));
  });

  test("quotes the declared n first, then roughly double and roughly half it", () => {
    expect(sampleSizeAdvisory({ items: 12, replicates: 2 }).references.map((row) => row.n))
      .toEqual([24, 48, 12]);
    // Odd n rounds rather than truncating to a size the operator would not recognize as "half".
    expect(sampleSizeAdvisory({ items: 25, replicates: 1 }).references.map((row) => row.n))
      .toEqual([25, 50, 13]);
  });

  test("does not repeat a size: at n = 1, half of it is itself", () => {
    expect(sampleSizeAdvisory({ items: 1, replicates: 1 }).references.map((row) => row.n))
      .toEqual([1, 2]);
  });

  test("every reference row carries the width for its own n", () => {
    for (const row of sampleSizeAdvisory({ items: 3, replicates: 5 }).references) {
      expect(row.expectedIntervalWidth).toBe(expectedIntervalWidth(row.n));
    }
  });
});

describe("formatSampleSizeAdvisory", () => {
  test("names the declared n and its width, then one line per reference size", () => {
    const advisory = sampleSizeAdvisory({ items: 12, replicates: 2 });
    const text = formatSampleSizeAdvisory(advisory);
    expect(text).toContain(`n=24`);
    expect(text).toContain(advisory.expectedIntervalWidth);
    for (const row of advisory.references) {
      expect(text).toContain(`  n=${row.n}: interval width ${row.expectedIntervalWidth}`);
    }
  });

  test("bounds the width over the pass rate only, and says what can still widen it", () => {
    const text = formatSampleSizeAdvisory(sampleSizeAdvisory({ items: 12, replicates: 2 }));
    // wilson@1 divides by the cells that score, not by the cells the plan named, so an advisory
    // that promised a flat ceiling would be the exact self-deception this gate exists to prevent.
    expect(text).toContain("no pass rate this run can have");
    expect(text).toContain("Cells that do not score");
  });
});
