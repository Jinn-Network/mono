/**
 * The seal-time sample-size advisory (issue #2978).
 *
 * At lock the product accepts whatever replicate and item counts the draft carries, and the
 * interval those counts imply is computable before a single cell is dispatched. A bare rate on a
 * small n is the most common way honest people mislead themselves and their readers; printing the
 * width the declared n can actually deliver — next to the widths at roughly double and half that n
 * — turns sample size from an unexamined cost decision into a measurement decision, taken while
 * results cannot yet tempt anyone.
 *
 * Two choices make the number honest before any result exists:
 *
 * - **n is the per-arm scorable trial count the plan commits to**, `items x replicates`. That is
 *   the denominator `wilson@1` divides by, so quoting anything else would quote a width no arm
 *   could have.
 * - **The width is taken at p = 0.5.** Wilson width depends on the pass rate, and the pass rate is
 *   unknown at the seal. p = 0.5 maximizes the width over p, so it is both the only p-free answer
 *   available and the conservative one: no pass rate this run turns out to have will widen the
 *   interval past the printed number.
 *
 * That bound is over the pass rate, and only over the pass rate. `wilson@1` divides by the cells
 * that actually score, and a cell can fail to score — excluded, or its replicates reduce to a
 * conflicted verdict — so a run that loses cells reports an interval wider than this one. The
 * printed width is therefore what the declared n buys if the plan is delivered whole, not a
 * guarantee about a run that comes back short. Saying so is the point: an advisory against
 * self-deception cannot itself promise more than it can keep.
 *
 * The interval itself is the shipped `wilsonInterval` — the same function `wilson@1` reports
 * through — so the advisory cannot drift from the method it is advising about.
 */

import { wilsonInterval } from "@jinn-network/benchmarking-aggregate";

/** One row of the advisory: a sample size and the widest 95% interval that many scored trials give. */
export interface SampleSizeWidth {
  readonly n: number;
  /** Canonical 4-decimal spelling, as every other interval in a sealed record is spelled. */
  readonly expectedIntervalWidth: string;
}

export interface SampleSizeAdvisory extends SampleSizeWidth {
  /**
   * The declared n first, then the reference sizes. Deduplicated, so a run at n = 1 does not print
   * "half of 1" as a second row saying the same thing.
   */
  readonly references: readonly SampleSizeWidth[];
}

/**
 * Width of the 95% Wilson interval at p = 0.5 for `n` trials, spelled to four decimals.
 *
 * `n` must be a positive integer; the advisory exists to describe a run that will actually happen,
 * and a zero or fractional trial count is a caller bug rather than a width worth printing.
 */
export function expectedIntervalWidth(n: number): string {
  if (!Number.isInteger(n) || n < 1) {
    throw new RangeError(`sample size must be a positive integer, received ${n}`);
  }
  const { lo, hi } = wilsonInterval(n / 2, n);
  return (hi - lo).toFixed(4);
}

function width(n: number): SampleSizeWidth {
  return { n, expectedIntervalWidth: expectedIntervalWidth(n) };
}

/**
 * The advisory for a plan of `items` tasks at `replicates` replicates: the width at the declared n,
 * plus the widths at roughly double and half it. "Roughly" is the point — the reference sizes exist
 * to show the shape of the tradeoff (how much narrower does twice the compute buy, how much wider
 * is half), not to be reachable configurations.
 */
export function sampleSizeAdvisory(input: {
  readonly items: number;
  readonly replicates: number;
}): SampleSizeAdvisory {
  const n = input.items * input.replicates;
  const declared = width(n);
  const referenceSizes = [n, n * 2, Math.max(1, Math.round(n / 2))];
  return {
    ...declared,
    references: [...new Set(referenceSizes)].map(width),
  };
}

/**
 * The operator-facing advisory text: one line naming the declared n, then one line per reference.
 *
 * The lead line is scoped to the pass rate on purpose. Whatever this run's pass rate turns out to
 * be, the interval at n scored trials is no wider than this — but cells that never score narrow
 * the denominator, and the operator is told so rather than left to discover it in the Report.
 */
export function formatSampleSizeAdvisory(advisory: SampleSizeAdvisory): string {
  const rows = advisory.references
    .map((reference) => `  n=${reference.n}: interval width ${reference.expectedIntervalWidth}`)
    .join("\n");
  return `At the declared n=${advisory.n} per arm, no pass rate this run can have gives a 95% `
    + `interval wider than ${advisory.expectedIntervalWidth}. At this and neighboring sample sizes:`
    + `\n${rows}\nCells that do not score (excluded, or conflicted across replicates) lower the `
    + `denominator and widen the interval past this.`;
}
