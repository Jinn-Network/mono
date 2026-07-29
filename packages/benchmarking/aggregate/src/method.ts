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
  readonly subjects: readonly MethodSubject[];
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly verdictRule: VerdictRuleName;
  readonly resolveVerdictBytes: (verdictDigest: string) => Uint8Array | undefined;
  readonly resolveRunBytes: (runDigest: string) => Uint8Array | undefined;
  readonly resolveTaskBytes: (taskDigest: string) => Uint8Array | undefined;
  readonly resolveAnchoredBenchmarkAnnouncement?: (benchmarkDigest: string) => Uint8Array | undefined;
  readonly verifyAnchoredBenchmarkAnnouncement?: AnchoredBenchmarkAnnouncementVerifier;
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

export interface AnchoredBenchmarkAnnouncementVerificationInput {
  readonly benchmarkDigest: string;
  readonly envelopeBytes: Uint8Array;
  readonly entryBytes: Uint8Array;
  readonly entryDigest: string;
  readonly source: { readonly agent: string; readonly name: string };
  readonly sequence: string;
  readonly previous: string | null;
  readonly entryTimestamp: string;
}

export type AnchoredBenchmarkAnnouncementVerification =
  | {
      readonly ok: true;
      readonly source: { readonly agent: string; readonly name: string };
      /** Genesis-to-head entry digests authenticated as one append-only source chain. */
      readonly verifiedEntryDigests: readonly string[];
      readonly headDigest: string;
      /** Authenticated append-only anchor observation for that exact head. */
      readonly anchor: { readonly digest: string; readonly anchorTime: string };
    }
  | { readonly ok: false; readonly reason: string };

export type AnchoredBenchmarkAnnouncementVerifier = (
  input: AnchoredBenchmarkAnnouncementVerificationInput,
) => AnchoredBenchmarkAnnouncementVerification;

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
  readonly compute?: (input: MethodComputeInput) => MethodResults;
}

/** The method-URI + version registry (design §9.2, §14.7). */
export interface MethodRegistry {
  get(id: string, version: string): Method | undefined;
}
