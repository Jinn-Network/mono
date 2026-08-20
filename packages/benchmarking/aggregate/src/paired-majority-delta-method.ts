import { compareCodeUnitStrings } from "@jinn-network/benchmarking-records";
import type { BinaryInstrumentExcludedItem, BinaryInstrumentItemDecision } from "./binary-instrument.js";
import {
  BINARY_INSTRUMENT_MEASUREMENT_PROFILE,
  BINARY_INSTRUMENT_PARAMETER_SCHEMA,
  CANDIDATE_CLASS,
  fixed4,
  resolveBinaryInstrumentReduction,
  STRATUM_NAME,
  type BinaryInstrumentParameters,
  type BinaryInstrumentQualificationComputeInput,
} from "./binary-instrument-method.js";
import type { Method } from "./method.js";
import { resolveTaskProvenance } from "./resolved-inputs.js";
import { clusteredPairedDeltaInterval, sourceClusterManifest } from "./stats/paired-delta.js";
import { MAX_NONINFERIORITY_RESAMPLES_V1, type ClusteredTaskRate } from "./stats/noninferiority.js";

/**
 * Frozen derivation constants (spec §7.2a, coordinator ruling on packet P5, issue #2837): all
 * thirteen `paired-majority-delta@1` parameters are derived from the draft and the sealed
 * closure, never caller-supplied. `verdictRule`/`k`/`reduction`/`measurementProfile`/
 * `candidateClasses`/`strata`/`parserInvalidPolicy`/`truthAdmission` derive from the sealed
 * binary-instrument closure, and `baseline`/`candidate` derive from the arm roster — but the
 * draft carries no source for `seed`, `resamples`, or `alpha`. These three are pre-registered at
 * lock rather than tuned, so the later core-side derivation (`compilePairedMajorityDeltaProfile`)
 * has a named source to seal into the analysis plan. The method itself still reads all three off
 * its own sealed `parameters` at compute time, exactly as `paired-delta@1` does — these constants
 * are not read by `computePairedMajorityDelta` below.
 */
/** The value the per-arm binary-instrument@1 headline seals as `intervalAlpha` — the same
 * interval level, which is the whole argument for `alpha` superseding `intervalAlpha` rather than
 * sitting beside it. */
export const PAIRED_MAJORITY_DELTA_ALPHA = "0.05" as const;
/** Matches the repo's existing `DEMO1_EQUIVALENCE_RESAMPLES`; well under
 * `MAX_NONINFERIORITY_RESAMPLES_V1` (100,000). */
export const PAIRED_MAJORITY_DELTA_RESAMPLES = 20_000;
/** One frozen xorshift32-v1 seed in 1..4294967295, pre-registered at lock. */
export const PAIRED_MAJORITY_DELTA_SEED = 20_260_819;

/**
 * §7.2a's registry row enumerates `parameterSchema.required` as thirteen entries: the eight
 * `binary-instrument@1` derives (all nine of that method's own required set minus
 * `intervalAlpha`, superseded by `alpha` below), plus `paired-delta@1`'s five pairing/interval
 * parameters minus `verdictRule` (already carried). Property definitions for the eight shared
 * keys are reused from `BINARY_INSTRUMENT_PARAMETER_SCHEMA` rather than retyped, so the
 * regex/array constraints cannot drift between the two schemas.
 */
const PAIRED_MAJORITY_DELTA_REQUIRED = [
  "verdictRule",
  "k",
  "reduction",
  "measurementProfile",
  "candidateClasses",
  "strata",
  "parserInvalidPolicy",
  "truthAdmission",
  "baseline",
  "candidate",
  "seed",
  "resamples",
  "alpha",
] as const;

const SHARED_BINARY_INSTRUMENT_KEYS = [
  "verdictRule",
  "k",
  "reduction",
  "measurementProfile",
  "candidateClasses",
  "strata",
  "parserInvalidPolicy",
  "truthAdmission",
] as const;

export const PAIRED_MAJORITY_DELTA_PARAMETER_SCHEMA: Method["parameterSchema"] = {
  type: "object",
  required: [...PAIRED_MAJORITY_DELTA_REQUIRED],
  properties: {
    ...Object.fromEntries(
      SHARED_BINARY_INSTRUMENT_KEYS.map((key) => [key, BINARY_INSTRUMENT_PARAMETER_SCHEMA.properties[key]!]),
    ),
    baseline: { type: "string" },
    candidate: { type: "string" },
    seed: { type: "integer", minimum: 1, maximum: 4_294_967_295 },
    resamples: { type: "integer", minimum: 1, maximum: MAX_NONINFERIORITY_RESAMPLES_V1 },
    // `intervalAlpha` ({enum: ["0.05"]}) is deliberately absent: `alpha`'s three-member enum is a
    // strict superset, and sealing both would put two keys for one interval level in one
    // parameter set under additionalProperties: false (spec §7.2a).
    alpha: { enum: ["0.10", "0.05", "0.01"] },
  },
  additionalProperties: false,
};

export interface PairedMajorityDeltaParameters {
  readonly verdictRule: "sole";
  readonly k: number;
  readonly reduction: "strict-majority";
  readonly measurementProfile: typeof BINARY_INSTRUMENT_MEASUREMENT_PROFILE;
  readonly candidateClasses: readonly string[];
  readonly strata: readonly string[];
  readonly parserInvalidPolicy: "reject";
  readonly truthAdmission: BinaryInstrumentParameters["truthAdmission"];
  readonly baseline: string;
  readonly candidate: string;
  readonly seed: number;
  readonly resamples: number;
  readonly alpha: "0.10" | "0.05" | "0.01";
}

/**
 * A sibling of `validatePairwiseDisagreementParameters`, for the same reason that validator gives
 * for not reusing `validateBinaryInstrumentParameters`: the generic `validateParameters`
 * (registry.ts) does not understand array-shaped parameters (`candidateClasses`/`strata`), so it
 * cannot enforce the sorted-unique-closed-vocabulary rule these two array parameters carry. The
 * required-thirteen checks below are otherwise the union of `pairwise-disagreement@1`'s own eight
 * shared-key checks and `paired-delta@1`'s five pairing/interval checks; neither is weakened.
 */
export function validatePairedMajorityDeltaParameters(
  parameters: Readonly<Record<string, unknown>>,
): { readonly ok: true } | { readonly ok: false; readonly issues: readonly string[] } {
  const issues: string[] = [];
  const required = new Set<string>(PAIRED_MAJORITY_DELTA_PARAMETER_SCHEMA.required);
  for (const key of required) {
    if (!Object.hasOwn(parameters, key)) issues.push(`missing required parameter "${key}"`);
  }
  for (const key of Object.keys(parameters)) {
    if (!required.has(key)) issues.push(`unknown parameter "${key}"`);
  }
  if (parameters["verdictRule"] !== "sole") issues.push('parameter "verdictRule" must be "sole"');
  const k = parameters["k"];
  if (!Number.isSafeInteger(k) || typeof k !== "number" || k < 1 || k % 2 === 0) {
    issues.push('parameter "k" must be an odd positive safe integer');
  }
  if (parameters["reduction"] !== "strict-majority") {
    issues.push('parameter "reduction" must be "strict-majority"');
  }
  if (parameters["measurementProfile"] !== BINARY_INSTRUMENT_MEASUREMENT_PROFILE) {
    issues.push(`parameter "measurementProfile" must be "${BINARY_INSTRUMENT_MEASUREMENT_PROFILE}"`);
  }
  const candidateClasses = parameters["candidateClasses"];
  if (
    !Array.isArray(candidateClasses)
    || candidateClasses.length === 0
    || candidateClasses.some((value) => typeof value !== "string" || !CANDIDATE_CLASS.test(value))
  ) {
    issues.push('parameter "candidateClasses" must be a non-empty array of closed class names');
  } else {
    const sorted = [...candidateClasses].sort(compareCodeUnitStrings);
    if (
      new Set(candidateClasses).size !== candidateClasses.length
      || sorted.some((value, index) => value !== candidateClasses[index])
    ) {
      issues.push('parameter "candidateClasses" must be unique and code-unit sorted');
    }
  }
  const strata = parameters["strata"];
  if (
    !Array.isArray(strata)
    || strata.length === 0
    || strata.some((value) => typeof value !== "string" || !STRATUM_NAME.test(value))
  ) {
    issues.push('parameter "strata" must be a non-empty array of stratum names');
  } else {
    const sortedStrata = [...strata].sort(compareCodeUnitStrings);
    if (
      new Set(strata).size !== strata.length
      || sortedStrata.some((value, index) => value !== strata[index])
    ) {
      issues.push('parameter "strata" must be unique and code-unit sorted');
    }
  }
  if (parameters["parserInvalidPolicy"] !== "reject") {
    issues.push('parameter "parserInvalidPolicy" must be "reject"');
  }
  if (
    parameters["truthAdmission"] !== "two-human-unanimous"
    && parameters["truthAdmission"] !== "operator-only"
    && parameters["truthAdmission"] !== "screened-operator-sampled"
  ) {
    issues.push('parameter "truthAdmission" is outside its enum');
  }
  const baseline = parameters["baseline"];
  const candidate = parameters["candidate"];
  if (typeof baseline !== "string" || baseline.length === 0) {
    issues.push('parameter "baseline" must be a non-empty string');
  }
  if (typeof candidate !== "string" || candidate.length === 0) {
    issues.push('parameter "candidate" must be a non-empty string');
  }
  if (typeof baseline === "string" && typeof candidate === "string" && baseline === candidate) {
    issues.push('parameters "baseline" and "candidate" must name distinct arms');
  }
  const seed = parameters["seed"];
  if (!Number.isSafeInteger(seed) || typeof seed !== "number" || seed < 1 || seed > 4_294_967_295) {
    issues.push('parameter "seed" must be an integer in 1..4294967295');
  }
  const resamples = parameters["resamples"];
  if (
    !Number.isSafeInteger(resamples)
    || typeof resamples !== "number"
    || resamples < 1
    || resamples > MAX_NONINFERIORITY_RESAMPLES_V1
  ) {
    issues.push(`parameter "resamples" must be an integer in 1..${MAX_NONINFERIORITY_RESAMPLES_V1}`);
  }
  if (parameters["alpha"] !== "0.10" && parameters["alpha"] !== "0.05" && parameters["alpha"] !== "0.01") {
    issues.push('parameter "alpha" is outside its enum');
  }
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

function parametersFrom(input: Readonly<Record<string, unknown>>): PairedMajorityDeltaParameters {
  const validation = validatePairedMajorityDeltaParameters(input);
  if (!validation.ok) {
    throw new Error(`invalid paired-majority-delta@1 parameters: ${validation.issues.join("; ")}`);
  }
  return input as unknown as PairedMajorityDeltaParameters;
}

/** Below this many paired Tasks the interval is withheld rather than manufactured. Inherited
 * unchanged from `paired-delta@1`'s `MIN_PAIRED_DELTA_TASKS` (registry.ts) — spec §7.2a. */
const MIN_PAIRED_MAJORITY_DELTA_TASKS = 5;

function withholdingReasons(n: number, clusterCount: number): string[] {
  const reasons: string[] = [];
  if (n < MIN_PAIRED_MAJORITY_DELTA_TASKS) {
    reasons.push(`fewer than minN=${MIN_PAIRED_MAJORITY_DELTA_TASKS} paired tasks (got ${n})`);
  }
  if (clusterCount < 2) {
    reasons.push(`fewer than two source clusters (got ${clusterCount})`);
  }
  return reasons;
}

interface DeltaProjection {
  readonly n: number;
  readonly delta: string | null;
  readonly interval: { readonly lower: string; readonly upper: string; readonly alpha: string } | null;
  readonly reasons: readonly string[];
}

/** Applies the package's shipped two-sided clustered BCa (`clusteredPairedDeltaInterval`,
 * unmodified) to majority differences instead of mean rates, exactly once per scope (overall,
 * then once per candidate-class/stratum slice). Nothing about the resampler, the cluster
 * manifest, or the jackknife acceleration is reimplemented. */
function deltaProjection(
  rates: readonly ClusteredTaskRate[],
  alpha: "0.10" | "0.05" | "0.01",
  seed: number,
  resamples: number,
): DeltaProjection {
  const clusterCount = new Set(rates.map((rate) => JSON.stringify(rate.cluster))).size;
  const reasons = withholdingReasons(rates.length, clusterCount);
  const estimate = reasons.length === 0
    ? clusteredPairedDeltaInterval(rates, { seed, resamples, alpha: Number(alpha) })
    : undefined;
  // One source for the point estimate: when the bootstrap ran, its own `observed` IS the mean
  // (same values, same task-sorted order), so reusing it removes any chance of the reported delta
  // and the interval it sits inside disagreeing in a last bit (mirrors paired-delta@1).
  const delta = estimate !== undefined
    ? estimate.delta
    : rates.length === 0
      ? null
      : rates.reduce((sum, rate) => sum + (rate.pB - rate.pA), 0) / rates.length;
  return {
    n: rates.length,
    delta: delta === null ? null : fixed4(delta),
    interval: estimate === undefined ? null : { lower: fixed4(estimate.low), upper: fixed4(estimate.high), alpha },
    reasons,
  };
}

interface ExclusionTriple {
  readonly taskDigest: string;
  readonly armId: string;
  readonly reason: string;
}

function compareExclusion(left: ExclusionTriple, right: ExclusionTriple): number {
  const byTask = compareCodeUnitStrings(left.taskDigest, right.taskDigest);
  if (byTask !== 0) return byTask;
  const byArm = compareCodeUnitStrings(left.armId, right.armId);
  return byArm !== 0 ? byArm : compareCodeUnitStrings(left.reason, right.reason);
}

function toBit(decision: "ACCEPT" | "REJECT"): number {
  return decision === "ACCEPT" ? 1 : 0;
}

/**
 * Registered `jinn.benchmarking.method/paired-majority-delta@1` (spec §7.2a, packet P5, issue
 * #2837): the evidence contrast. The paired difference in per-item agreement between `candidate`
 * (the evidence-declaring arm) and `baseline` (its evidence-free twin), over the item-majority
 * decision unit.
 *
 * **Sign contract, stated once so no report author re-derives it:** `delta` is `candidate`'s bit
 * minus `baseline`'s bit, mirroring `paired-delta@1`'s `pB - pA`. **A positive `delta` means the
 * evidence-declaring arm agrees MORE than its evidence-free twin.**
 *
 * **Frozen: the majority reduction is single-sourced from `resolveBinaryInstrumentReduction`
 * (binary-instrument-method.ts), which itself single-sources `reduceBinaryInstrumentReplicates`
 * (binary-instrument.ts). Never reimplemented.** Three registered methods computing majority
 * three different ways would be three numbers waiting to disagree in public. One import, three
 * callers.
 *
 * **Exclusions compose in order.** First `binary-instrument@1`'s: an item-arm group is included
 * only if it has exactly `k` cells with a resolved decision. Then the pairing's: an item excluded
 * for either arm of the pair is excluded from the pair. Because the Matrix always carries the
 * full task x arm x replicate coordinate set, every Task has exactly one covering entry (an item
 * XOR an exclusion) per arm — so "paired" collapses exactly to "has an item for both arms", with
 * no separate half-paired case to reason about.
 */
export function computePairedMajorityDelta(
  input: BinaryInstrumentQualificationComputeInput,
): unknown {
  const parameters = parametersFrom(input.parameters);
  if (input.verdictRule !== "sole") {
    throw new Error(`paired-majority-delta@1 requires MethodComputeInput.verdictRule=sole; got ${input.verdictRule}`);
  }
  const { reduction } = resolveBinaryInstrumentReduction(input, {
    k: parameters.k,
    candidateClasses: parameters.candidateClasses,
    strata: parameters.strata,
    truthAdmission: parameters.truthAdmission,
  });

  const itemsByArm = new Map<string, Map<string, BinaryInstrumentItemDecision>>();
  for (const item of reduction.items) {
    const byTask = itemsByArm.get(item.armId) ?? new Map<string, BinaryInstrumentItemDecision>();
    byTask.set(item.taskDigest, item);
    itemsByArm.set(item.armId, byTask);
  }
  const excludedByArm = new Map<string, BinaryInstrumentExcludedItem[]>();
  for (const excludedItem of reduction.excluded) {
    if (excludedItem.armId !== parameters.baseline && excludedItem.armId !== parameters.candidate) continue;
    const list = excludedByArm.get(excludedItem.armId) ?? [];
    list.push(excludedItem);
    excludedByArm.set(excludedItem.armId, list);
  }

  const baselineItems = itemsByArm.get(parameters.baseline) ?? new Map<string, BinaryInstrumentItemDecision>();
  const candidateItems = itemsByArm.get(parameters.candidate) ?? new Map<string, BinaryInstrumentItemDecision>();
  const pairedTaskDigests = [...baselineItems.keys()]
    .filter((taskDigest) => candidateItems.has(taskDigest))
    .sort(compareCodeUnitStrings);

  const rates: ClusteredTaskRate[] = pairedTaskDigests.map((taskDigest) => {
    const provenance = resolveTaskProvenance(taskDigest, input);
    return {
      taskDigest,
      pA: toBit(baselineItems.get(taskDigest)!.decision),
      pB: toBit(candidateItems.get(taskDigest)!.decision),
      cluster: [provenance.cluster.tag, provenance.cluster.value] as const,
    };
  });

  const overall = deltaProjection(rates, parameters.alpha, parameters.seed, parameters.resamples);
  const clusterManifest = sourceClusterManifest(rates);

  const byCandidateClass = parameters.candidateClasses.map((candidateClass) => {
    const slice = rates.filter((rate) =>
      baselineItems.get(rate.taskDigest)!.context.candidateClass === candidateClass);
    return { candidateClass, ...deltaProjection(slice, parameters.alpha, parameters.seed, parameters.resamples) };
  });

  const byStratum = parameters.strata.map((stratum) => {
    const slice = rates.filter((rate) => baselineItems.get(rate.taskDigest)!.context.stratum === stratum);
    return { stratum, ...deltaProjection(slice, parameters.alpha, parameters.seed, parameters.resamples) };
  });

  const exclusions: ExclusionTriple[] = [
    ...(excludedByArm.get(parameters.baseline) ?? []),
    ...(excludedByArm.get(parameters.candidate) ?? []),
  ]
    .flatMap((excludedItem) => excludedItem.reasons.map((detail) => ({
      taskDigest: excludedItem.taskDigest,
      armId: excludedItem.armId,
      reason: detail.reason,
    })))
    .sort(compareExclusion);

  return {
    baseline: parameters.baseline,
    candidate: parameters.candidate,
    n: overall.n,
    delta: overall.delta,
    interval: overall.interval,
    reasons: overall.reasons,
    clusters: { count: clusterManifest.length, manifest: clusterManifest },
    byCandidateClass,
    byStratum,
    exclusions,
    // Envelope field every registered method carries regardless of its own scientific content
    // (wilson@1, paired-delta@1, binary-instrument@1, pairwise-disagreement@1 all do). Sourced
    // directly from the shared reduction; nothing here is derived or invented. Named `conflicted`
    // (not §7.2a's literal `conflictedCells`), matching how `paired-delta@1` itself reports it —
    // the spec's own trailing comment says "as paired-delta@1 reports them", and paired-delta@1
    // reports it under this name and shape.
    conflicted: reduction.conflicted,
  };
}
