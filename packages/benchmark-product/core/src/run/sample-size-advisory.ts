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
 *
 * ## Why the width is not extended to the comparison readouts (issue #3832)
 *
 * A published claim does not have to be a per-arm rate: `report/claim.ts` admits `wilson@1`'s
 * `headline` or one of three comparisons. An operator who is going to publish a delta reads this
 * width while deciding sample size, and it does not bound the thing they will publish.
 *
 * A seal-time bound on those comparisons was considered and rejected as **not computable**.
 * `paired-delta@1`'s interval comes from `clusteredPairedDeltaInterval`, a clustered BCa bootstrap
 * over the observed per-task discordance and the source-cluster manifest — neither of which exists
 * before a cell is dispatched. `pairwise-disagreement@1` and `paired-majority-delta@1` share that
 * shape. The only quantity that IS a function of n alone is the trivial ±1 envelope, and printing
 * a width of 2.0000 beside an honest Wilson ceiling would bound nothing anyone would act on while
 * looking like it did. That is the self-deception this gate exists to prevent, so nothing is
 * printed.
 *
 * What is printed instead is the scope: when the draft declares a readout this width does not
 * cover, the advisory names it, so the operator is not left to infer which of their numbers the
 * ceiling applies to. Naming is free and needs no unknown — the declared analyses are readable off
 * the draft at the lock.
 */

import { wilsonInterval } from "@jinn-network/benchmarking-aggregate";
import { BENCHMARKING_METHOD_IDS } from "@jinn-network/benchmarking-records";

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
  /**
   * The draft's declared readouts this width does NOT bound (issue #3832), spelled the way
   * `report/claim.ts` spells them — `paired-delta@1`, not the method URI.
   *
   * Absent rather than empty when the draft declares nothing but `wilson@1`, which is every draft
   * that existed before this field: an absent key keeps the advisory object, the CLI's `--json`
   * envelope, and the printed text byte-identical for those drafts.
   */
  readonly unboundedReadouts?: readonly string[];
}

/** A declared analysis-plan entry, structurally: the draft's `analysis` and `additionalAnalyses`. */
export interface DeclaredAnalysis {
  readonly method: string;
  readonly version: string;
}

const METHOD_ID_PREFIX = "jinn.benchmarking.method/";

/**
 * The declared readouts whose uncertainty is not the per-arm Wilson width — every declared method
 * that is not `wilson@1`. Deduplicated and in declaration order, so the line reads the way the
 * plan does.
 */
function unboundedReadoutsOf(declared: readonly DeclaredAnalysis[]): readonly string[] {
  const named = declared
    .filter((analysis) => analysis.method !== BENCHMARKING_METHOD_IDS.wilson)
    .map((analysis) => {
      const short = analysis.method.startsWith(METHOD_ID_PREFIX)
        ? analysis.method.slice(METHOD_ID_PREFIX.length)
        : analysis.method;
      return `${short}@${analysis.version}`;
    });
  return [...new Set(named)];
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
  /**
   * The draft's declared analysis-plan entries, primary first. Used only to name the readouts this
   * width does not bound (issue #3832); it never changes n or the width, and it never reaches the
   * sealed `sample-size-advisory/v1` extension.
   */
  readonly declaredAnalyses?: readonly DeclaredAnalysis[];
}): SampleSizeAdvisory {
  const n = input.items * input.replicates;
  const declared = width(n);
  const referenceSizes = [n, n * 2, Math.max(1, Math.round(n / 2))];
  const unbounded = unboundedReadoutsOf(input.declaredAnalyses ?? []);
  return {
    ...declared,
    references: [...new Set(referenceSizes)].map(width),
    ...(unbounded.length === 0 ? {} : { unboundedReadouts: unbounded }),
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
  // Scope, when the draft declares a readout this width does not cover (issue #3832). No width is
  // offered for those: none is computable at the seal, and a fabricated one would be worse than
  // silence. Naming them is what stops the operator reading this ceiling as covering their delta.
  const scope = advisory.unboundedReadouts === undefined
    ? ""
    : `\nThis bounds a per-arm pass rate only. The declared readouts `
      + `${advisory.unboundedReadouts.join(", ")} report their own intervals, computed from the `
      + `pairing and clustering this run turns out to have, which no sample size fixes in advance.`;
  return `At the declared n=${advisory.n} per arm, no pass rate this run can have gives a 95% `
    + `interval wider than ${advisory.expectedIntervalWidth}. At this and neighboring sample sizes:`
    + `\n${rows}\nCells that do not score (excluded, or conflicted across replicates) lower the `
    + `denominator and widen the interval past this.${scope}`;
}
