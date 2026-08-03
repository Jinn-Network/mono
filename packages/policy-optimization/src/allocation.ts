// SPDX-License-Identifier: MIT

/**
 * Dev-wave allocation (product design §6.2): a **pure** decision function — ports in, decision out.
 *
 * > Between waves the allocator decides which candidates get how many cells next, using: prior wave
 * > Reports, the outcomes projection (organic bucket), and task informativeness from the curation
 * > projection (saturated tasks discriminate nothing).
 *
 * Three things this file deliberately does not do.
 *
 * 1. **It computes no statistic** (program ruling R3). Every operation here is counting, exact
 *    comparison, or selection: a Report value is compared as an exact decimal (`parseExactDecimal`
 *    + a common scale, both `@jinn-network/benchmarking-records`'), and an observed rate is
 *    compared by integer cross-multiplication, exactly as curation's own `compareRateTo` does.
 *    Nothing is averaged, smoothed, or estimated, and nothing this file produces is published as a
 *    measurement. A campaign needing a new estimator gets a registry method with a reference
 *    implementation first.
 * 2. **It reads no Report.** The `WaveReportRow` port carries the value a registry method already
 *    sealed. Parsing a `results` block here would make the product a second, private reader of a
 *    method's output shape — and the first time a method changed that shape the product would
 *    quietly rank on something else.
 * 3. **It touches nothing.** No clock, no filesystem, no randomness. Two hosts holding the same
 *    rows decide the same thing, which is what makes the journaled decision auditable rather than
 *    merely recorded.
 *
 * **The hazard, restated because it is real.** §6.2: allocation inputs include the manipulable
 * organic bucket, so poisoned signal can prune the genuinely best candidate before promotion — a
 * *wrong recommendation*, not merely wasted budget. That is why `inputs` carries every row the
 * decision consumed and why the journal records it: the confinement is that the promotion claim
 * never rests on allocation, and the audit trail is that survivorship is reconstructable.
 */

import {
  compareCodeUnitStrings,
  parseExactDecimal,
  scaleDecimal,
} from "@jinn-network/benchmarking-records";
import { issue, refuse, refuseAll, type PolicyOptimizationIssue } from "./errors.js";
import type { CampaignDocument, JsonValue } from "./types.js";
import type {
  AdmittedCandidate,
  AllocationDecision,
  AllocationInputRefs,
  DroppedTask,
  OutcomesProjectionRow,
  PrunedCandidate,
  RateBound,
  TaskInformativenessRow,
  WaveReportRow,
} from "./wave-types.js";

/**
 * The v0 allocation policies, named. A campaign's `allocation.policyRef` must be one of these:
 * an unrecognized reference is refused rather than silently falling back to uniform, because a
 * campaign that believed it was pruning and was not would draw its conclusions from a wave it did
 * not plan.
 */
export const ALLOCATION_POLICY_REFS = [
  "uniform/1.0",
  "drop-bottom-k/1.0",
  "informativeness/1.0",
] as const;

export type AllocationPolicyRef = (typeof ALLOCATION_POLICY_REFS)[number];

export interface AllocationInput {
  readonly campaign: CampaignDocument;
  /** 1-based; the wave this decision is *for*. */
  readonly waveNumber: number;
  /** The admitted population, whole. Pruning selects from it; it never adds. */
  readonly population: readonly AdmittedCandidate[];
  /** The development Benchmark's task digests, in the record's own item order. */
  readonly taskDigests: readonly string[];
  /** Prior-wave Report rows. Empty at wave 1 — the policies must be total on that. */
  readonly reports?: readonly WaveReportRow[];
  /** Outcomes-projection rows; only the `organic` bucket is read (§8.1). */
  readonly outcomes?: readonly OutcomesProjectionRow[];
  /** Curation rows carrying observed task pass rates. */
  readonly informativeness?: readonly TaskInformativenessRow[];
}

// --- exact comparisons (no statistic is computed, nothing is estimated) --------------------------

/**
 * Orders two decimal strings exactly: `-1`, `0`, `1`, or `undefined` when either side is not a
 * plain decimal.
 *
 * `undefined` is not "equal". A method whose output the product cannot order is a method the
 * product must not rank on, and pretending two unorderable values tie would silently make the
 * ranking depend on array order.
 */
export function compareExactDecimals(left: string, right: string): -1 | 0 | 1 | undefined {
  const a = parseExactDecimal(left);
  const b = parseExactDecimal(right);
  if (a === undefined || b === undefined) return undefined;
  const scale = a.scale > b.scale ? a.scale : b.scale;
  const scaledLeft = scaleDecimal(a, scale);
  const scaledRight = scaleDecimal(b, scale);
  return scaledLeft === scaledRight ? 0 : scaledLeft < scaledRight ? -1 : 1;
}

/**
 * Orders two observed rates by exact integer cross-multiplication — curation's `compareRateTo`
 * shape, mirrored rather than imported.
 *
 * `undefined` when either side has no decision-grade verdicts (`den === 0`): the comparison is not
 * observable and this function does not guess.
 */
export function compareObservedRates(
  left: { readonly num: number; readonly den: number },
  right: { readonly num: number; readonly den: number },
): -1 | 0 | 1 | undefined {
  if (left.den <= 0 || right.den <= 0) return undefined;
  const a = left.num * right.den;
  const b = right.num * left.den;
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) {
    refuse("allocation-policy", "outcomes", "rate comparison exceeds the exact integer range");
  }
  return a === b ? 0 : a < b ? -1 : 1;
}

/** Is the observed rate at or outside a bound? Exact integer cross-multiplication, as above. */
function rateAtOrBeyond(
  rate: { readonly num: number; readonly den: number },
  bound: RateBound,
  direction: "at-or-below" | "at-or-above",
): boolean | undefined {
  if (rate.den <= 0 || bound.den <= 0) return undefined;
  const left = rate.num * bound.den;
  const right = bound.num * rate.den;
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) {
    refuse("allocation-policy", "informativeness", "rate comparison exceeds the exact integer range");
  }
  return direction === "at-or-below" ? left <= right : left >= right;
}

// --- parameters ---------------------------------------------------------------------------------

function integerParameter(
  parameters: Readonly<Record<string, JsonValue>>,
  key: string,
  fallback: number | undefined,
  minimum: number,
): number {
  const value = parameters[key];
  if (value === undefined) {
    if (fallback === undefined) {
      refuse("allocation-policy", `allocation.parameters.${key}`, `parameter "${key}" is required`);
    }
    return fallback;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    refuse("allocation-policy", `allocation.parameters.${key}`,
      `parameter "${key}" must be an integer >= ${minimum}`);
  }
  return value;
}

function rateParameter(
  parameters: Readonly<Record<string, JsonValue>>,
  key: string,
  fallback: RateBound | undefined,
): RateBound {
  const value = parameters[key];
  if (value === undefined) {
    if (fallback === undefined) {
      refuse("allocation-policy", `allocation.parameters.${key}`,
        `parameter "${key}" is required; there is no default saturation threshold`);
    }
    return fallback;
  }
  if (
    typeof value !== "object" || value === null || Array.isArray(value)
    || typeof (value as Record<string, unknown>)["num"] !== "number"
    || typeof (value as Record<string, unknown>)["den"] !== "number"
  ) {
    refuse("allocation-policy", `allocation.parameters.${key}`,
      `parameter "${key}" must be an exact rational {num, den}`);
  }
  const bound = value as unknown as RateBound;
  if (!Number.isSafeInteger(bound.num) || !Number.isSafeInteger(bound.den)
    || bound.den <= 0 || bound.num < 0) {
    refuse("allocation-policy", `allocation.parameters.${key}`,
      `parameter "${key}" must be a non-negative rate with a positive denominator`);
  }
  return bound;
}

// --- the decision -------------------------------------------------------------------------------

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(compareCodeUnitStrings);
}

/** The most recent Report row per tuple, by wave number then Report digest (deterministic). */
function latestReportRows(rows: readonly WaveReportRow[]): Map<string, WaveReportRow> {
  const latest = new Map<string, WaveReportRow>();
  for (const row of rows) {
    const current = latest.get(row.tupleDigest);
    if (
      current === undefined
      || row.waveNumber > current.waveNumber
      || (row.waveNumber === current.waveNumber
        && compareCodeUnitStrings(row.reportDigest, current.reportDigest) > 0)
    ) {
      latest.set(row.tupleDigest, row);
    }
  }
  return latest;
}

function organicRateFor(
  rows: readonly OutcomesProjectionRow[],
  tupleDigest: string,
): OutcomesProjectionRow | undefined {
  return rows.find((row) => row.bucket === "organic" && row.tupleDigest === tupleDigest);
}

/**
 * Which objective method the ranking reads.
 *
 * The campaign's **first** objective method, deliberately: `objective.methods` is ordered, an
 * objective with several methods has a primary one, and picking "whichever row happens to be
 * present" would make the ranking depend on what the adapter fetched rather than on what the
 * campaign declared.
 */
function rankingMethod(campaign: CampaignDocument): { id: string; version: string } {
  const [method] = campaign.objective.methods;
  if (method === undefined) {
    refuse("allocation-policy", "objective.methods", "an objective needs at least one method to rank on");
  }
  return { id: method.id, version: method.version };
}

function dropBottomK(input: AllocationInput, retainedIds: string[]): {
  retained: string[];
  pruned: PrunedCandidate[];
  notes: string[];
} {
  const parameters = input.campaign.allocation.parameters;
  const k = integerParameter(parameters, "k", undefined, 0);
  const minCandidates = integerParameter(parameters, "minCandidates", 2, 1);
  const method = rankingMethod(input.campaign);
  const reports = (input.reports ?? []).filter(
    (row) => row.method.id === method.id && row.method.version === method.version,
  );
  const latest = latestReportRows(reports);
  const outcomes = input.outcomes ?? [];
  const notes: string[] = [];

  // A candidate nothing has measured is never pruned. Pruning on absence of evidence is how a
  // freshly-admitted candidate gets dropped for having arrived late rather than for being worse.
  const rankable = retainedIds.filter((tupleDigest) => latest.has(tupleDigest));
  const unmeasured = retainedIds.filter((tupleDigest) => !latest.has(tupleDigest));
  if (unmeasured.length > 0) {
    notes.push(`${unmeasured.length} candidate(s) carry no ${method.id}@${method.version} Report row and are retained unranked`);
  }

  const ordered = [...rankable].sort((left, right) => {
    const leftRow = latest.get(left)!;
    const rightRow = latest.get(right)!;
    const byValue = compareExactDecimals(leftRow.value, rightRow.value);
    if (byValue === undefined) {
      refuseAll([issue("allocation-policy", "reports",
        `Report value ${JSON.stringify(leftRow.value)} or ${JSON.stringify(rightRow.value)} is not an exact decimal; the product does not invent an ordering for a method output it cannot compare`)]);
    }
    if (byValue !== 0) return byValue;
    // Tie-break on the manipulable organic bucket — §6.2's named hazard, made real rather than
    // decorative. It orders ties only; it never overturns experimental evidence.
    const leftOrganic = organicRateFor(outcomes, left);
    const rightOrganic = organicRateFor(outcomes, right);
    if (leftOrganic !== undefined && rightOrganic !== undefined) {
      const byRate = compareObservedRates(leftOrganic.passRate, rightOrganic.passRate);
      if (byRate !== undefined && byRate !== 0) return byRate;
    }
    return compareCodeUnitStrings(left, right);
  });

  const droppable = Math.max(0, Math.min(k, ordered.length + unmeasured.length - minCandidates));
  if (droppable < k) {
    notes.push(`k=${k} would leave fewer than minCandidates=${minCandidates}; pruning ${droppable}`);
  }
  const pruned: PrunedCandidate[] = ordered.slice(0, droppable).map((tupleDigest) => ({
    tupleDigest,
    reason: `bottom-${droppable} on ${method.id}@${method.version} (value ${latest.get(tupleDigest)!.value}, Report ${latest.get(tupleDigest)!.reportDigest})`,
  }));
  const prunedSet = new Set(pruned.map((entry) => entry.tupleDigest));
  return {
    retained: retainedIds.filter((tupleDigest) => !prunedSet.has(tupleDigest)),
    pruned,
    notes,
  };
}

function selectInformativeTasks(input: AllocationInput): {
  taskDigests: string[];
  dropped: DroppedTask[];
  notes: string[];
} {
  const parameters = input.campaign.allocation.parameters;
  const minVerdicts = integerParameter(parameters, "minVerdicts", undefined, 1);
  const lower = rateParameter(parameters, "lower", undefined);
  const upper = rateParameter(parameters, "upper", undefined);
  const rows = (input.informativeness ?? []).filter((row) => row.bucket === "benchmark");
  const byTask = new Map(rows.map((row) => [row.taskDigest, row] as const));
  const notes: string[] = [];
  const dropped: DroppedTask[] = [];
  const kept: string[] = [];

  for (const taskDigest of input.taskDigests) {
    const row = byTask.get(taskDigest);
    if (row === undefined || row.passRate.den < minVerdicts) {
      kept.push(taskDigest);
      continue;
    }
    const belowFloor = rateAtOrBeyond(row.passRate, lower, "at-or-below");
    const aboveCeiling = rateAtOrBeyond(row.passRate, upper, "at-or-above");
    if (belowFloor === true || aboveCeiling === true) {
      dropped.push({
        taskDigest,
        reason: belowFloor === true
          ? `observed rate ${row.passRate.num}/${row.passRate.den} at or below ${lower.num}/${lower.den} over ${row.passRate.den} verdicts`
          : `observed rate ${row.passRate.num}/${row.passRate.den} at or above ${upper.num}/${upper.den} over ${row.passRate.den} verdicts`,
      });
      continue;
    }
    kept.push(taskDigest);
  }

  // A wave with no tasks measures nothing. When every task looks saturated the honest move is to
  // run the whole slate and say so, not to seal a Run with an empty Benchmark.
  if (kept.length === 0) {
    notes.push(`every task looked saturated; retaining the full slate rather than sealing an empty wave`);
    return { taskDigests: [...input.taskDigests], dropped: [], notes };
  }
  return { taskDigests: kept, dropped, notes };
}

/**
 * Decides the next dev wave's allocation. Pure.
 *
 * The promotion Run never comes through here: §6.2 confines pruning and informativeness-weighted
 * sampling to exploration, and `planPromotionRun` builds its own flat decision.
 */
export function decideAllocation(input: AllocationInput): AllocationDecision {
  const policyRef = input.campaign.allocation.policyRef;
  if (!(ALLOCATION_POLICY_REFS as readonly string[]).includes(policyRef)) {
    refuse("allocation-policy", "allocation.policyRef",
      `unknown allocation policy ${JSON.stringify(policyRef)}; v0 implements ${ALLOCATION_POLICY_REFS.join(", ")}`);
  }
  if (!Number.isSafeInteger(input.waveNumber) || input.waveNumber < 1) {
    refuse("allocation-policy", "waveNumber", "waveNumber is 1-based");
  }
  if (input.population.length === 0) {
    refuse("allocation-policy", "population", "an allocation decision over an empty population decides nothing");
  }
  if (input.taskDigests.length === 0) {
    refuse("allocation-policy", "taskDigests", "the development Benchmark contributes no tasks to allocate over");
  }

  const parameters = input.campaign.allocation.parameters;
  const replicates = integerParameter(parameters, "replicates", 1, 1);
  const populationIds = input.population.map((candidate) => candidate.tupleDigest);
  const duplicate = populationIds.find((id, index) => populationIds.indexOf(id) !== index);
  if (duplicate !== undefined) {
    refuse("allocation-policy", "population",
      `tuple ${duplicate} appears twice; population membership is keyed by tupleDigest (§7.3)`);
  }

  const issues: PolicyOptimizationIssue[] = [];
  for (const [index, row] of (input.reports ?? []).entries()) {
    if (!populationIds.includes(row.tupleDigest)) {
      issues.push(issue("allocation-policy", `reports.${index}.tupleDigest`,
        `Report row names ${row.tupleDigest}, which is not in the population`));
    }
  }
  if (issues.length > 0) refuseAll(issues);

  let retained = [...populationIds];
  let pruned: readonly PrunedCandidate[] = [];
  let taskDigests: readonly string[] = [...input.taskDigests];
  let droppedTasks: readonly DroppedTask[] = [];
  const notes: string[] = [];

  if (policyRef === "drop-bottom-k/1.0") {
    const outcome = dropBottomK(input, retained);
    retained = outcome.retained;
    pruned = outcome.pruned;
    notes.push(...outcome.notes);
  } else if (policyRef === "informativeness/1.0") {
    const outcome = selectInformativeTasks(input);
    taskDigests = outcome.taskDigests;
    droppedTasks = outcome.dropped;
    notes.push(...outcome.notes);
  } else {
    notes.push("uniform: every admitted candidate runs on every task in the development slate");
  }

  if (retained.length === 0) {
    refuse("allocation-policy", "retained", "an allocation that prunes every candidate ends the wave, not the search");
  }

  const inputs: AllocationInputRefs = {
    reports: sortedUnique((input.reports ?? []).map((row) => row.reportDigest)),
    outcomes: sortedUnique((input.outcomes ?? []).map((row) => row.rowRef)),
    informativeness: sortedUnique((input.informativeness ?? []).map((row) => row.rowRef)),
  };

  return {
    policyRef,
    waveNumber: input.waveNumber,
    retained: [...retained].sort(compareCodeUnitStrings),
    pruned: [...pruned].sort((left, right) => compareCodeUnitStrings(left.tupleDigest, right.tupleDigest)),
    taskDigests,
    droppedTasks: [...droppedTasks].sort((left, right) => compareCodeUnitStrings(left.taskDigest, right.taskDigest)),
    replicates,
    inputs,
    notes,
  };
}
