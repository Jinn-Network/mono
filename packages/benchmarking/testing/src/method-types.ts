import type { MatrixRecord } from "@jinn-network/benchmarking-records";
import type { VerdictOutcome } from "@jinn-network/task-execution-profiles";

/** The contract-wide multi-verdict reduction name (design §9.2) — never a report-time free string. */
export type VerdictRuleName = "sole" | "unanimous" | "any-pass" | "majority";

/**
 * The injected shape every §9.2 method's `compute()` receives. Pure — no I/O, no marketplace or
 * evidence imports (tier-3 `aggregate`, design §15). `resolveVerdict` dereferences a matrix
 * cell's `validVerdicts[]` digest to its resolved pass/fail/inconclusive outcome (the Matrix
 * record itself carries no aggregate of any kind, tenet 3, so this is how a Method reads what
 * each verdict actually decided). `resolveClusterKey` and `resolveTaskTimestamp` are optional
 * ports a method MAY consult; a report-time `parameters` value can never substitute for either
 * (design §9.2: the clustering key and the clean-subset basis are not report-time parameters).
 */
export interface MethodComputeInput {
  readonly matrices: readonly MatrixRecord[];
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly verdictRule: VerdictRuleName;
  readonly resolveVerdict: (verdictDigest: string) => VerdictOutcome | undefined;
  readonly resolveClusterKey?: (taskDigest: string) => string | undefined;
  readonly resolveTaskTimestamp?: (taskDigest: string) => string | undefined;
  /** `clean-subset@1`'s delegate call (§9.2: "restrict... then delegate to another method") is
   * the only method that needs this — every other method ignores it. */
  readonly registry?: MethodRegistry;
}

export type MethodReferenceSet = "v1-reference" | "registered-non-reference";
export type ComputeAvailability = "available" | "unavailable";

export interface DeclarativeParameterSchema {
  readonly type: "object";
  readonly required: readonly string[];
  readonly properties: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly additionalProperties: boolean;
}

export type ParameterValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: readonly string[] };

/**
 * A registered §9.2 method is a declarative spec, not merely a dispatch function. The metadata
 * is part of the frozen registry contract and is fixture-pinned by the kit.
 */
export interface Method {
  readonly id: string;
  readonly version: string;
  readonly requiredInputs: readonly string[];
  readonly parameterSchema: DeclarativeParameterSchema;
  readonly outputShape: string;
  readonly exclusionRule: string;
  readonly clusteringRule: string;
  readonly referenceSet: MethodReferenceSet;
  readonly deterministic: true;
  /** Required for resampling methods; omitted when the method is deterministic without PRNG. */
  readonly resamplingProcedure?: string;
  readonly computeAvailability: ComputeAvailability;
  readonly versionRobust: boolean;
  validateParameters(parameters: Readonly<Record<string, unknown>>): ParameterValidationResult;
  readonly compute?: (input: MethodComputeInput) => unknown;
}

/** The kit's injected shape (design §16): `aggregate` implements this over its seven methods. */
export interface MethodRegistry {
  get(id: string, version: string): Method | undefined;
}
