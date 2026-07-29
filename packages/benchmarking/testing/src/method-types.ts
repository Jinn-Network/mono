import type { MatrixRecord } from "@jinn-network/benchmarking-records";
/** The contract-wide multi-verdict reduction name (design §9.2) — never a report-time free string. */
export type VerdictRuleName = "sole" | "unanimous" | "any-pass" | "majority";

export interface VerifiedAnchoredBenchmarkAnnouncement {
  /** Exact signed discovery Announcement Entry envelope bytes. */
  readonly envelopeBytes: Uint8Array;
  /** Exact canonical Announcement Entry payload bytes authenticated by `envelopeBytes`. */
  readonly entryBytes: Uint8Array;
  /** Verifier-authenticated anchor time, never an author-supplied timestamp callback. */
  readonly anchoredAt: string;
  readonly verification: "verified";
}

/**
 * The injected shape every §9.2 method's `compute()` receives. Pure — no I/O, no marketplace or
 * evidence imports (tier-3 `aggregate`, design §15). Every resolver returns exact bytes and the
 * implementation binds the requested digest to those bytes before use. Verdict outcomes,
 * provenance-source clusters, self-declared provenance timestamps, Run replicate counts, and
 * pre-registration facts are parsed from those exact bytes — never supplied as derived callbacks.
 */
export interface MethodComputeInput {
  readonly subjects: readonly MethodSubject[];
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly verdictRule: VerdictRuleName;
  readonly resolveVerdictBytes: (verdictDigest: string) => Uint8Array | undefined;
  readonly resolveRunBytes: (runDigest: string) => Uint8Array | undefined;
  readonly resolveTaskBytes: (taskDigest: string) => Uint8Array | undefined;
  readonly resolveAnchoredBenchmarkAnnouncement?: (
    benchmarkDigest: string,
  ) => VerifiedAnchoredBenchmarkAnnouncement | undefined;
  /** `clean-subset@1`'s delegate call (§9.2: "restrict... then delegate to another method") is
   * the only method that needs this — every other method ignores it. */
  readonly registry?: MethodRegistry;
}

export interface MethodSubject {
  /** Exact lowercase sha256 digest of the corresponding canonical Matrix bytes. */
  readonly subjectSha256: string;
  readonly matrix: MatrixRecord;
}

export interface SubjectMethodResult {
  readonly subjectSha256: string;
  readonly results: unknown;
}

export interface MethodResults {
  /** Same length/order and exact identities as MethodComputeInput.subjects. */
  readonly perSubject: readonly SubjectMethodResult[];
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
  readonly compute?: (input: MethodComputeInput) => MethodResults;
}

/** The kit's injected shape (design §16): `aggregate` implements this over its seven methods. */
export interface MethodRegistry {
  get(id: string, version: string): Method | undefined;
}
