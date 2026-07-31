import { CurationInputError } from "./observation.js";
import type { CurationRow, Ratio } from "./projection.js";

/**
 * The research band the design cites as a REFERENCE (section 9): observed pass rates
 * concentrate in [2%, 70%], peaking near 50%, and a task drifting past ~70% is exhausting
 * its signal. Documentation and display only -- no function in this package applies it. The
 * consumer supplies its own threshold, always, explicitly.
 */
export const SATURATION_REFERENCE_BAND = { min: 0.02, max: 0.70 } as const;

/**
 * The same band as exact ratios -- the form `compareRateTo`/`saturationAt` consume, because
 * this package never lets a float touch a rate. Pass
 * `SATURATION_REFERENCE_BAND_RATIO.max` to adopt the reference upper bound deliberately.
 */
export const SATURATION_REFERENCE_BAND_RATIO = {
  min: { num: 2, den: 100 },
  max: { num: 70, den: 100 },
} as const;

function assertThreshold(threshold: Ratio): void {
  if (!Number.isSafeInteger(threshold.num) || !Number.isSafeInteger(threshold.den)) {
    throw new CurationInputError("threshold num and den must be exact integers");
  }
  if (threshold.den <= 0 || threshold.num < 0) {
    throw new CurationInputError("threshold must be a non-negative rate with a positive denominator");
  }
}

/**
 * Orders a row's observed pass rate against a threshold by exact integer cross-
 * multiplication: `-1` below, `0` equal, `1` above. `undefined` when the row has no
 * decision-grade verdicts (`den === 0`) -- the comparison is not observable, and this
 * function does not guess.
 */
export function compareRateTo(row: CurationRow, threshold: Ratio): -1 | 0 | 1 | undefined {
  assertThreshold(threshold);
  if (row.passRate.den === 0) return undefined;
  const left = row.passRate.num * threshold.den;
  const right = threshold.num * row.passRate.den;
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) {
    throw new CurationInputError("rate comparison exceeds the exact integer range");
  }
  return left === right ? 0 : left < right ? -1 : 1;
}

/**
 * Whether a row's observed pass rate sits strictly above a CALLER-SUPPLIED threshold.
 * `undefined` when the row has no decision-grade verdicts. There is no default threshold.
 */
export function saturationAt(row: CurationRow, threshold: Ratio): boolean | undefined {
  const comparison = compareRateTo(row, threshold);
  return comparison === undefined ? undefined : comparison > 0;
}
