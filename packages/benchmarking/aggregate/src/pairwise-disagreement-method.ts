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
import { wilsonInterval } from "./stats/wilson.js";

const PAIRWISE_DISAGREEMENT_REQUIRED = [
  "verdictRule",
  "k",
  "reduction",
  "measurementProfile",
  "candidateClasses",
  "strata",
  "parserInvalidPolicy",
  "truthAdmission",
  "intervalAlpha",
] as const;

/**
 * §7.1's registry row (`docs/superpowers/specs/2026-08-19-judge-path-delta-contracts.md`)
 * enumerates `parameterSchema.required` as eight entries, omitting `truthAdmission`. **Coordinator
 * ruling (P5, packet #2837): it is nine** — exactly `BINARY_INSTRUMENT_PARAMETER_SCHEMA`'s nine
 * required entries. §7.2a's ratified argument for sealing `truthAdmission` into
 * `paired-majority-delta@1` is method-agnostic: three registered Reports over one collected cell
 * set must publish at one disclosure level, so it applies to this method too. Property
 * definitions are reused from `BINARY_INSTRUMENT_PARAMETER_SCHEMA` rather than retyped, so the
 * regex/array constraints for the shared keys cannot drift between the two schemas.
 *
 * `judgeModelProfile` is deliberately excluded: it exists only to drive binary-instrument's own
 * per-profile limitations output, this method emits no limitations, and sealing a parameter
 * nothing reads is exactly the defect §7.1's own `byStratum` correction exists to prevent.
 */
export const PAIRWISE_DISAGREEMENT_PARAMETER_SCHEMA: Method["parameterSchema"] = {
  type: "object",
  required: [...PAIRWISE_DISAGREEMENT_REQUIRED],
  properties: Object.fromEntries(
    PAIRWISE_DISAGREEMENT_REQUIRED.map((key) => [key, BINARY_INSTRUMENT_PARAMETER_SCHEMA.properties[key]!]),
  ),
  additionalProperties: false,
};

export interface PairwiseDisagreementParameters {
  readonly verdictRule: "sole";
  readonly k: number;
  readonly reduction: "strict-majority";
  readonly measurementProfile: typeof BINARY_INSTRUMENT_MEASUREMENT_PROFILE;
  readonly candidateClasses: readonly string[];
  readonly strata: readonly string[];
  readonly parserInvalidPolicy: "reject" | "abstain";
  readonly truthAdmission: BinaryInstrumentParameters["truthAdmission"];
  readonly intervalAlpha: "0.05";
}

/**
 * A sibling of `validateBinaryInstrumentParameters` (binary-instrument-method.ts), not a reuse of
 * it: that validator treats `judgeModelProfile` as an accepted optional key, which this method
 * must refuse (see the schema comment above). The required-nine checks below are otherwise
 * identical in shape and must stay that way — the sorted-and-unique and enum rules are not
 * weakened or forked, only re-scoped to this method's own required set.
 */
export function validatePairwiseDisagreementParameters(
  parameters: Readonly<Record<string, unknown>>,
): { readonly ok: true } | { readonly ok: false; readonly issues: readonly string[] } {
  const issues: string[] = [];
  const required = new Set<string>(PAIRWISE_DISAGREEMENT_PARAMETER_SCHEMA.required);
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
  if (
    parameters["parserInvalidPolicy"] !== "reject"
    && parameters["parserInvalidPolicy"] !== "abstain"
  ) {
    issues.push('parameter "parserInvalidPolicy" must be "reject" or "abstain"');
  }
  if (
    parameters["truthAdmission"] !== "two-human-unanimous"
    && parameters["truthAdmission"] !== "operator-only"
    && parameters["truthAdmission"] !== "screened-operator-sampled"
  ) {
    issues.push('parameter "truthAdmission" is outside its enum');
  }
  if (parameters["intervalAlpha"] !== "0.05") {
    issues.push('parameter "intervalAlpha" must be "0.05"');
  }
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

function parametersFrom(input: Readonly<Record<string, unknown>>): PairwiseDisagreementParameters {
  const validation = validatePairwiseDisagreementParameters(input);
  if (!validation.ok) {
    throw new Error(`invalid pairwise-disagreement@1 parameters: ${validation.issues.join("; ")}`);
  }
  return input as unknown as PairwiseDisagreementParameters;
}

interface DisagreementCount {
  readonly n: number;
  readonly disagreements: number;
  readonly rate: string | null;
  readonly interval: { readonly lower: string; readonly upper: string; readonly alpha: string } | null;
}

/** Zero-denominator slices carry their (zero) counts and no manufactured interval — never a
 * fabricated 0.0000 rate for an empty slice. */
function disagreementCount(n: number, disagreements: number, alpha: string): DisagreementCount {
  if (n === 0) {
    return { n, disagreements, rate: null, interval: null };
  }
  const interval = wilsonInterval(disagreements, n);
  return {
    n,
    disagreements,
    rate: fixed4(interval.p),
    // `alpha` is fixed-4 like `lower`/`upper` (spec §7.1's exact interval shape): all three fields
    // of one interval print at one precision, and the asset layer's own paired-delta@1 rendering
    // already fixed-4s alpha, so emitting "0.05" here would have made the method output and the
    // rendered claim disagree on the same number's spelling.
    interval: { lower: fixed4(interval.lo), upper: fixed4(interval.hi), alpha: fixed4(Number(alpha)) },
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

/**
 * Registered `jinn.benchmarking.method/pairwise-disagreement@1` (spec §7.1, packet P5, issue
 * #2837): all unordered arm-pair item-majority disagreement counts in one pass. No `baseline`, no
 * `candidate`, no ranking — a symmetric pair count, never a winner.
 *
 * **Frozen: the majority reduction is single-sourced from `resolveBinaryInstrumentReduction`
 * (binary-instrument-method.ts), which itself single-sources `reduceBinaryInstrumentReplicates`
 * (binary-instrument.ts). Never reimplemented.** Two implementations of one reduction is two
 * numbers waiting to disagree in public.
 */
export function computePairwiseDisagreement(
  input: BinaryInstrumentQualificationComputeInput,
): unknown {
  const parameters = parametersFrom(input.parameters);
  if (input.verdictRule !== "sole") {
    throw new Error(`pairwise-disagreement@1 requires MethodComputeInput.verdictRule=sole; got ${input.verdictRule}`);
  }
  const { reduction, instruments } = resolveBinaryInstrumentReduction(input, {
    k: parameters.k,
    candidateClasses: parameters.candidateClasses,
    strata: parameters.strata,
    truthAdmission: parameters.truthAdmission,
    parserInvalidPolicy: parameters.parserInvalidPolicy,
  });

  const armIds = instruments.map((instrument) => instrument.armId).sort(compareCodeUnitStrings);

  const itemsByArm = new Map<string, Map<string, BinaryInstrumentItemDecision>>();
  for (const item of reduction.items) {
    const byTask = itemsByArm.get(item.armId) ?? new Map<string, BinaryInstrumentItemDecision>();
    byTask.set(item.taskDigest, item);
    itemsByArm.set(item.armId, byTask);
  }
  const excludedByArm = new Map<string, BinaryInstrumentExcludedItem[]>();
  for (const excludedItem of reduction.excluded) {
    const list = excludedByArm.get(excludedItem.armId) ?? [];
    list.push(excludedItem);
    excludedByArm.set(excludedItem.armId, list);
  }

  const pairs: unknown[] = [];
  for (let left = 0; left < armIds.length; left += 1) {
    for (let right = left + 1; right < armIds.length; right += 1) {
      const armA = armIds[left]!;
      const armB = armIds[right]!;
      const itemsA = itemsByArm.get(armA) ?? new Map<string, BinaryInstrumentItemDecision>();
      const itemsB = itemsByArm.get(armB) ?? new Map<string, BinaryInstrumentItemDecision>();
      const commonTaskDigests = [...itemsA.keys()].filter((taskDigest) => itemsB.has(taskDigest));
      const disagreesOn = (taskDigest: string): boolean =>
        itemsA.get(taskDigest)!.decision !== itemsB.get(taskDigest)!.decision;

      const byCandidateClass = parameters.candidateClasses.map((candidateClass) => {
        const slice = commonTaskDigests.filter((taskDigest) =>
          itemsA.get(taskDigest)!.context.candidateClass === candidateClass);
        return {
          candidateClass,
          ...disagreementCount(slice.length, slice.filter(disagreesOn).length, parameters.intervalAlpha),
        };
      });

      const byStratum = parameters.strata.map((stratum) => {
        const slice = commonTaskDigests.filter((taskDigest) =>
          itemsA.get(taskDigest)!.context.stratum === stratum);
        return {
          stratum,
          ...disagreementCount(slice.length, slice.filter(disagreesOn).length, parameters.intervalAlpha),
        };
      });

      const exclusions: ExclusionTriple[] = [
        ...(excludedByArm.get(armA) ?? []),
        ...(excludedByArm.get(armB) ?? []),
      ]
        .flatMap((excludedItem) => excludedItem.reasons.map((detail: { readonly reason: string }) => ({
          taskDigest: excludedItem.taskDigest,
          armId: excludedItem.armId,
          reason: detail.reason,
        })))
        .sort(compareExclusion);

      pairs.push({
        armA,
        armB,
        ...disagreementCount(commonTaskDigests.length, commonTaskDigests.filter(disagreesOn).length, parameters.intervalAlpha),
        byCandidateClass,
        byStratum,
        exclusions,
      });
    }
  }

  // Envelope field every registered method carries regardless of its own scientific content
  // (wilson@1, paired-delta@1, binary-instrument@1 all do; `core/src/report/claim.ts`'s
  // `MethodProjection` declares it required). §7.1's "exact" output shape omits it; per the
  // coordinator's 2026-08-20 ruling on packet P5 this is a spec erratum, not an intentional
  // narrowing — a method that dropped it would force the claim builder to either fabricate an
  // always-empty conflicted block or refuse, and a false published zero is worse than either.
  // Sourced directly from the shared reduction; nothing here is derived or invented.
  return { pairs, conflicted: reduction.conflicted };
}
