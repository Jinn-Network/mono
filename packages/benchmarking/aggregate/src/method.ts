import type { MatrixRecord } from "@jinn-network/benchmarking-records";

// This package's dependency boundary is records + trust-core only (plan M3 Task 3.1
// Interfaces; no task-execution-* import from aggregate/src). `VerdictOutcome` is structurally
// identical to `@jinn-network/task-execution-profiles`' `evaluateVerdictRule` output — defined
// locally, not imported, so a value built by that package's `evaluateVerdictRule` is still
// assignable here (structural typing), without this package depending on profiles.
export type VerdictOutcome = { verdict: "pass" | "fail" | "inconclusive"; inconclusiveClass?: string };

/** The contract-wide multi-verdict reduction name (design §9.2). */
export type VerdictRuleName = "sole" | "unanimous" | "any-pass" | "majority";

/**
 * The shape every §9.2 method's `compute()` receives — structurally identical to
 * `@jinn-network/benchmarking-testing`'s `MethodComputeInput` (kit-precedes-implementation,
 * program §7.6), defined locally for the same boundary reason as `VerdictOutcome` above.
 */
export interface MethodComputeInput {
  readonly matrices: readonly MatrixRecord[];
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly verdictRule: VerdictRuleName;
  readonly resolveVerdict: (verdictDigest: string) => VerdictOutcome | undefined;
  readonly resolveClusterKey?: (taskDigest: string) => string | undefined;
  readonly resolveTaskTimestamp?: (taskDigest: string) => string | undefined;
  readonly rng?: () => number;
  readonly registry?: MethodRegistry;
}

/** A registered §9.2 method: identified by URI + version, computing `results` from a matrix. */
export interface Method {
  readonly id: string;
  readonly version: string;
  readonly requiredInputs: readonly string[];
  readonly parameterSchema: {
    readonly type: "object";
    readonly required: readonly string[];
    readonly properties: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
    readonly additionalProperties: boolean;
  };
  readonly outputShape: string;
  readonly exclusionRule: string;
  readonly clusteringRule: string;
  readonly referenceSet: "v1-reference" | "registered-non-reference";
  readonly deterministic: true;
  readonly resamplingProcedure?: string;
  readonly computeAvailability: "available" | "unavailable";
  readonly versionRobust: boolean;
  validateParameters(parameters: Readonly<Record<string, unknown>>):
    | { readonly ok: true }
    | { readonly ok: false; readonly issues: readonly string[] };
  readonly compute?: (input: MethodComputeInput) => unknown;
}

/** The method-URI + version registry (design §9.2, §14.7). */
export interface MethodRegistry {
  get(id: string, version: string): Method | undefined;
}
