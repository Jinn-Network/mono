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
 * - **n is the per-arm scorable trial count**, `items x replicates`. That is the exact denominator
 *   every per-arm interval in the sealed Report divides by, so quoting anything else would quote a
 *   width no arm will ever have.
 * - **The width is taken at p = 0.5.** Wilson width depends on the pass rate, and the pass rate is
 *   unknown at the seal. p = 0.5 maximizes the width, so it is both the only p-free answer
 *   available and the conservative one: the printed width is a ceiling the run cannot exceed, never
 *   a promise it might miss.
 *
 * The interval itself is the shipped `wilsonInterval` — the same function `wilson@1` reports
 * through — so the advisory cannot drift from the method it is advising about.
 */

import { wilsonInterval } from "@jinn-network/benchmarking-aggregate";

/** One row of the advisory: a sample size and the widest 95% interval it can produce. */
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

/** The operator-facing advisory text: one line naming the declared n, then one line per reference. */
export function formatSampleSizeAdvisory(advisory: SampleSizeAdvisory): string {
  const rows = advisory.references
    .map((reference) => `  n=${reference.n}: interval width ${reference.expectedIntervalWidth}`)
    .join("\n");
  return `At the declared n=${advisory.n} per arm, the widest 95% interval this run can produce is `
    + `${advisory.expectedIntervalWidth} wide. At this and neighboring sample sizes:\n${rows}`;
}
