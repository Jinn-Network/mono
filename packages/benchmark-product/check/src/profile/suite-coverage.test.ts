// SPDX-License-Identifier: Apache-2.0

/**
 * The named coverage slices of an official suite, as the checker recomputes them.
 *
 * These two helpers used to live in the product core alone. A bundle that declares
 * `terminal-bench-2-1-comparability` states its coverage in a sealed Benchmark extension, and the
 * checker has to recompute that word from the selected names rather than copy it, so the rule
 * lives here and the core re-exports it.
 */

import { describe, expect, test } from "vitest";
import { SUITE_COVERAGE, coverageFromSelectedNames, namedSliceTaskNames } from "./suite-coverage.js";

const names = Array.from({ length: 12 }, (_, index) => `task-${String(index).padStart(2, "0")}`);
const shuffled = [...names].reverse();

describe("named coverage slices", () => {
  test("the four coverage words, in their fixed order", () => {
    expect(SUITE_COVERAGE).toEqual(["one_task", "ten_task", "full", "custom"]);
  });

  test("a slice is the first one, the first ten, or all, by Unicode code point", () => {
    expect(namedSliceTaskNames(shuffled, "one_task")).toEqual(["task-00"]);
    expect(namedSliceTaskNames(shuffled, "ten_task")).toEqual(names.slice(0, 10));
    expect(namedSliceTaskNames(shuffled, "full")).toEqual(names);
  });

  test("code-point order, not UTF-16 code-unit order", () => {
    // U+FF5E sorts before U+1F600 by code point and after it by UTF-16 code unit.
    expect(namedSliceTaskNames(["\u{1F600}", "～"], "full")).toEqual(["～", "\u{1F600}"]);
  });

  test("coverage is the slice the selection equals, in order, or custom", () => {
    expect(coverageFromSelectedNames(shuffled, ["task-00"])).toBe("one_task");
    expect(coverageFromSelectedNames(shuffled, names.slice(0, 10))).toBe("ten_task");
    expect(coverageFromSelectedNames(shuffled, names)).toBe("full");
    expect(coverageFromSelectedNames(shuffled, ["task-01"])).toBe("custom");
    // The same ten in another order is not the named slice.
    expect(coverageFromSelectedNames(shuffled, [...names.slice(0, 10)].reverse())).toBe("custom");
    expect(coverageFromSelectedNames(shuffled, [])).toBe("custom");
  });

  test("a dataset of one task reads as its smallest slice", () => {
    expect(coverageFromSelectedNames(["only"], ["only"])).toBe("one_task");
  });
});
