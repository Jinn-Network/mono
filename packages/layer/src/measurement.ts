/**
 * Three-arm measurement — the §11 capability gate for distillation-v1
 * (spec/2026-07-06-distillation-v1.md §11, D9/D11).
 *
 * REUSES the capability-eval rig — `comparePaired` / `mcnemarExact` (exact
 * McNemar) from `operator/src/eval/paired.ts`. This module is only the analysis
 * layer that composes those into the three-arm gate; the actual per-arm run
 * (executing the harness against the `cap-v0` slate with each corpus snapshot
 * pre-installed, graded by the swe-rebench-v2 grader) is wired at run time and
 * feeds this its per-instance results.
 *
 * NOTE: Wilson intervals (`wilson.ts`) are deliberately NOT used here. This is a
 * matched (paired) design — the same slate under each arm — so exact McNemar on
 * the discordant pairs is the correct test. Marginal Wilson intervals would
 * reintroduce the between-instance variance that the paired design exists to
 * remove (see `paired.ts`), so bolting one on would weaken, not strengthen, the
 * comparison. Do not add it.
 *
 * NOTE (§11.1 — process gate, not code): the IUT composition below — capability
 * = resolve-rate superiority AND cost non-inferiority — inverts cap-v0's
 * quality/cost roles and MUST be confirmed with the capability-eval session
 * before a `ship-distilled` verdict is treated as final. This module encodes the
 * shape; it cannot ratify it.
 *
 * Arms: **seeds-only** (control), **raw-evidence** (the shipped v1 product
 * baseline, D11), **distilled** (the bet). Two comparisons:
 *   - distilled vs seeds — the capability claim: **resolve-rate superiority**
 *     (trustworthy McNemar, distilled-favored) AND **cost non-inferior** on the
 *     both-solve set.
 *   - distilled vs raw-evidence — the **Bitter-Lesson test (D9)**: the distiller
 *     earns its place only if it beats raw-evidence retrieval; otherwise the
 *     retrieval baseline ships (D11).
 *
 * The first run is a **pilot** (§11): if the distilled-vs-seeds discordant count
 * cannot reach significance, the verdict is `inconclusive`, not a false null.
 */

import {
  comparePaired,
  mcnemarExact,
  type PairedComparison,
  type PairedInput,
} from '@jinn-network/core';

export interface ArmResult {
  instanceId: string;
  /** null when unscorable (disk-skip / harness failure) — never coerced to a flip. */
  passed: boolean | null;
  unscorable: boolean;
  /** Total cost of the run for this instance (USD). Optional; cost guard skips when absent. */
  costUsd?: number;
}

export interface PilotPower {
  discordant: number;
  netEffect: number;
  /** Smallest all-improve discordant count that can reach significance at alpha. */
  minDiscordantForSignificance: number;
  /**
   * True ⇒ the discordant count is large enough that SOME split could reach
   * significance. This is capability, NOT the result: `powered` says the run
   * *could* have been decisive in either direction, not that distilled won.
   * A powered run can still resolve to `within-noise` (e.g. an even split).
   */
  powered: boolean;
}

export interface ArmComparison {
  paired: PairedComparison;
  /** distilled mean cost ÷ baseline mean cost on the both-solve (concordant-pass) set; null when empty/absent. */
  costRatio: number | null;
  costNonInferior: boolean;
}

export type ShipVerdict = 'ship-distilled' | 'ship-retrieval-baseline' | 'inconclusive';

export interface ThreeArmResult {
  distilledVsSeeds: ArmComparison & { capabilityPass: boolean };
  distilledVsRaw: ArmComparison & { bitterLessonPass: boolean };
  pilot: PilotPower;
  shipVerdict: ShipVerdict;
}

const DEFAULT_ALPHA = 0.05;
const DEFAULT_COST_MARGIN = 0.1;

/**
 * Pilot power for an exact McNemar run. A run can only be significant if its
 * discordant count reaches `minDiscordantForSignificance` (the smallest n with
 * `mcnemarExact(n, 0) < alpha`). Below that, no split is significant, so a null
 * is uninformative (§11 — the first run is a pilot, a Haiku null uninformative).
 */
export function pilotPower(improved: number, regressed: number, alpha = DEFAULT_ALPHA): PilotPower {
  const discordant = improved + regressed;
  let minN = 1;
  while (mcnemarExact(minN, 0) >= alpha) minN++;
  return {
    discordant,
    netEffect: improved - regressed,
    minDiscordantForSignificance: minN,
    powered: discordant >= minN,
  };
}

function toPaired(arm: ArmResult[]): PairedInput[] {
  return arm.map((r) => ({ instance_id: r.instanceId, passed: r.passed, unscorable: r.unscorable }));
}

/**
 * Cost ratio (treatment ÷ baseline mean) on the set of instances BOTH arms
 * scored as passed (the both-solve set). Returns:
 *   - `null` when NO both-solve instance carries cost data on both arms — there
 *     is no basis to compare, so the guard is SKIPPED (not "verified
 *     non-inferior"; the caller must treat a null ratio on a ship verdict as
 *     "cost unverified" and confirm cost tracking was on).
 *   - `Infinity` when the baseline is free (baseSum === 0) but the treatment is
 *     not — a paid treatment over a free baseline is infinitely worse, which
 *     must FAIL the guard, not silently pass (the old `baseSum === 0 → null`
 *     branch failed open on exactly the seeds-only control most likely to be
 *     near-zero cost).
 *   - `0` when both are free.
 */
function costOnBothSolve(baseline: ArmResult[], treatment: ArmResult[]): number | null {
  const basePass = new Map(baseline.map((r) => [r.instanceId, r]));
  let baseSum = 0;
  let treatSum = 0;
  let n = 0;
  for (const t of treatment) {
    const b = basePass.get(t.instanceId);
    if (!b || b.passed !== true || t.passed !== true) continue;
    if (typeof b.costUsd !== 'number' || typeof t.costUsd !== 'number') continue;
    baseSum += b.costUsd;
    treatSum += t.costUsd;
    n++;
  }
  if (n === 0) return null; // no both-solve cost data → no basis → guard skipped
  if (baseSum === 0) return treatSum === 0 ? 0 : Infinity; // free baseline: equal if treat free, else fails
  return treatSum / baseSum;
}

function compareArm(baseline: ArmResult[], treatment: ArmResult[], alpha: number, costMargin: number): ArmComparison {
  const paired = comparePaired(toPaired(baseline), toPaired(treatment), { alpha });
  const costRatio = costOnBothSolve(baseline, treatment);
  // Non-inferior when there is no cost basis (null → guard SKIPPED, cost
  // UNVERIFIED — not verified-cheap) or the treatment is not materially more
  // expensive on the both-solve set. Infinity (free baseline, paid treatment)
  // fails the guard.
  const costNonInferior = costRatio === null ? true : costRatio <= 1 + costMargin;
  return { paired, costRatio, costNonInferior };
}

export function threeArmMeasurement(
  arms: { seedsOnly: ArmResult[]; rawEvidence: ArmResult[]; distilled: ArmResult[] },
  opts: { alpha?: number; costMargin?: number } = {},
): ThreeArmResult {
  const alpha = opts.alpha ?? DEFAULT_ALPHA;
  const costMargin = opts.costMargin ?? DEFAULT_COST_MARGIN;

  const vsSeeds = compareArm(arms.seedsOnly, arms.distilled, alpha, costMargin);
  const vsRaw = compareArm(arms.rawEvidence, arms.distilled, alpha, costMargin);
  const pilot = pilotPower(vsSeeds.paired.improved, vsSeeds.paired.regressed, alpha);

  // Capability (the ship claim): resolve-rate superiority over seeds AND cost non-inferior.
  const capabilityPass = vsSeeds.paired.verdict === 'trustworthy' && vsSeeds.costNonInferior;
  // Bitter-Lesson (D9): the distiller earns its place only if it beats raw-evidence.
  const bitterLessonPass = vsRaw.paired.verdict === 'trustworthy';

  let shipVerdict: ShipVerdict;
  if (!pilot.powered) {
    shipVerdict = 'inconclusive';
  } else if (capabilityPass && bitterLessonPass) {
    shipVerdict = 'ship-distilled';
  } else {
    // Retrieval-over-evidence is the product baseline regardless (D11): the
    // distiller either didn't beat raw-evidence or didn't clear the capability gate.
    shipVerdict = 'ship-retrieval-baseline';
  }

  return {
    distilledVsSeeds: { ...vsSeeds, capabilityPass },
    distilledVsRaw: { ...vsRaw, bitterLessonPass },
    pilot,
    shipVerdict,
  };
}
