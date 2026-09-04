import { describe, expect, test } from "vitest";
import { wilsonInterval } from "@jinn-network/benchmarking-aggregate";
import { BENCHMARKING_METHOD_IDS } from "@jinn-network/benchmarking-records";
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

/**
 * Issue #3832. The printed width is the ceiling on ONE ARM's Wilson interval, and three of the four
 * readouts a claim package may carry are comparisons whose interval is not that. No seal-time bound
 * on those is computable (see the module doc), so the advisory names them rather than inventing a
 * number for them.
 */
describe("the readouts the width does not bound", () => {
  const paired = { method: BENCHMARKING_METHOD_IDS.pairedDelta, version: "1" } as const;
  const wilson = { method: BENCHMARKING_METHOD_IDS.wilson, version: "1" } as const;

  test("a draft declaring only wilson@1 is unchanged: no list, and byte-identical text", () => {
    const bare = sampleSizeAdvisory({ items: 12, replicates: 2 });
    for (const declaredAnalyses of [[], [wilson]]) {
      const advisory = sampleSizeAdvisory({ items: 12, replicates: 2, declaredAnalyses });
      expect(advisory).toEqual(bare);
      expect(advisory).not.toHaveProperty("unboundedReadouts");
      expect(formatSampleSizeAdvisory(advisory)).toBe(formatSampleSizeAdvisory(bare));
    }
  });

  test("names a declared comparison the way a claim package spells it, not as a method URI", () => {
    const advisory = sampleSizeAdvisory({ items: 12, replicates: 2, declaredAnalyses: [paired] });
    expect(advisory.unboundedReadouts).toEqual(["paired-delta@1"]);
    expect(formatSampleSizeAdvisory(advisory)).toContain("paired-delta@1");
    expect(formatSampleSizeAdvisory(advisory)).not.toContain(BENCHMARKING_METHOD_IDS.pairedDelta);
  });

  test("names every declared comparison once, in declaration order, and drops wilson@1", () => {
    const advisory = sampleSizeAdvisory({
      items: 12,
      replicates: 2,
      declaredAnalyses: [
        wilson,
        { method: BENCHMARKING_METHOD_IDS.pairwiseDisagreement, version: "1" },
        paired,
        paired,
      ],
    });
    expect(advisory.unboundedReadouts).toEqual(["pairwise-disagreement@1", "paired-delta@1"]);
  });

  test("says the width does not cover them WITHOUT printing a width for them", () => {
    const advisory = sampleSizeAdvisory({ items: 12, replicates: 2, declaredAnalyses: [paired] });
    const text = formatSampleSizeAdvisory(advisory);
    expect(text).toContain("bounds a per-arm pass rate only");
    // The whole decision in one assertion: exactly the rows the per-arm ceiling covers carry a
    // width, and the comparison line carries none. A fabricated bound would show up as a fourth.
    expect(text.match(/interval width /g)).toHaveLength(advisory.references.length);
  });

  test("leaves n and the width untouched: naming scope is not a second measurement", () => {
    const scoped = sampleSizeAdvisory({ items: 12, replicates: 2, declaredAnalyses: [paired] });
    const bare = sampleSizeAdvisory({ items: 12, replicates: 2 });
    expect(scoped.n).toBe(bare.n);
    expect(scoped.expectedIntervalWidth).toBe(bare.expectedIntervalWidth);
    expect(scoped.references).toEqual(bare.references);
  });
});
