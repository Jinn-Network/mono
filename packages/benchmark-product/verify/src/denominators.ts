// SPDX-License-Identifier: Apache-2.0

/**
 * The two denominators a reader needs in order to see what a headline rate left out (issue #2977).
 *
 * A rate is a numerator over a denominator, and the denominator is the knob. `wilson@1` declares
 * one — the decisive judged cells (`benchmarking-aggregate`'s `selectScorableCells`: only a
 * `judged` cell scores, and a `judged` cell whose valid verdicts conflict is dropped after that).
 * The strictest reading of the same run is the other one: every slot the run planned counts, and a
 * slot that errored, timed out, expired, or was excluded counts as a slot that did not pass. Both
 * numbers are already sealed — the declared one in the Report's own per-arm facts, the strict one
 * in the Matrix's per-arm accounting — so stating them side by side recomputes nothing and cannot
 * disagree with the sealed judgment. That is the whole reason this derivation is a subtraction over
 * two sealed integers rather than a second rate: a numerator is not needed, and this module must
 * never become a place where a second estimate of the result is calculated.
 *
 * Single-sourced here for the reason `binding/report-face.ts` gives: `@colophon-claims/core`
 * depends on this package, so producer and reader run one function rather than two that can drift.
 *
 * Rendered on the operator's results route and, on the published bundle page, by
 * `benchmark-product-public-bundle/9` alone (issue #3698). Every earlier format renders the
 * declared denominator alone, permanently: a published page is immutable. No producer emits `/9`
 * yet — the reader understands it, and the flip waits on the release that serves it.
 */

/** The per-arm slice of a sealed Matrix's attrition this derivation reads. */
export interface PlannedSlotAccounting {
  readonly perArm: Readonly<Record<string, { readonly expected: number }>>;
}

/** One arm's declared denominator beside the strict all-slots one. */
export interface ArmDenominators {
  readonly armId: string;
  /** The method's declared denominator: the slots that entered the headline rate. */
  readonly declared: number;
  /**
   * Every slot the run planned for this arm, whatever became of it. `undefined` when the Matrix
   * carries no accounting for the arm at all — a withheld number, never a guessed zero, because a
   * zero here would read as "this arm planned nothing" and understate the exclusion.
   */
  readonly allSlots: number | undefined;
  /**
   * `allSlots − declared`: the planned slots the declared denominator leaves out. Named for the
   * denominator rather than for an outcome, because the Matrix's own attrition already has an
   * `excluded` count meaning one specific outcome, and this number is the sum of several of them
   * (unjudged, unscorable, expired, invalidated, excluded, and the judged cells a conflicting
   * verdict dropped). Zero is a result, not an absence, and is stated. A negative value is stated
   * too: a declared denominator larger than the run's own planned slots is a disagreement between
   * two sealed records, and hiding it would be the flattering direction.
   */
  readonly excludedFromDeclared: number | undefined;
}

/**
 * `arms` is stated in the order the caller read them out of the sealed Report, and that order is
 * preserved: this function decides nothing about presentation.
 */
export function armDenominators(
  arms: readonly { readonly armId: string; readonly n: number }[],
  attrition: PlannedSlotAccounting,
): readonly ArmDenominators[] {
  return arms.map(({ armId, n }) => {
    // `Object.hasOwn`, not a truthiness test on the looked-up value: arm ids are opaque wire keys
    // (the Matrix schema admits `__proto__`, `constructor`, and `toString` among them), and an
    // inherited member would otherwise resolve to a non-count and be read as accounting.
    const allSlots = Object.hasOwn(attrition.perArm, armId) ? attrition.perArm[armId]!.expected : undefined;
    return {
      armId,
      declared: n,
      allSlots,
      excludedFromDeclared: allSlots === undefined ? undefined : allSlots - n,
    };
  });
}
