// SPDX-License-Identifier: MIT

/**
 * The frozen type vocabulary of `@jinn-network/policy-identity` (program §1 C1 "Produces").
 *
 * Authority: `docs/superpowers/specs/2026-08-03-policy-identity-and-outcomes-design.md` §4–§5.
 *
 * This file is part of the **kit**: it fixes the shapes the conformance fixtures are expressed
 * in, so the implementation and the kit's naive reference deriver describe the same objects.
 * It contains no derivation, canonicalization, or validation logic.
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Substrate §4.1 — the execution-policy tuple.
 *
 * The four core axes are **always present**, `null` when the effective requirements do not
 * constrain them. Additional members are the Task profile's declared `requirementKeys` that are
 * present in the effective requirements; declared-but-unset keys are **omitted, never
 * null-filled**. `formatToken` is document metadata, not an axis.
 */
export interface ExecutionPolicyTuple {
  readonly formatToken: string;
  readonly harness: JsonValue;
  readonly model: JsonValue;
  readonly loadout: JsonValue;
  readonly isolationPolicy: JsonValue;
  readonly [profileAxis: string]: JsonValue;
}

/** Substrate §5.1 — a typed parent reference, discriminated so consumers know how to dereference. */
export interface PolicyParentRef {
  readonly kind: "candidate" | "tuple";
  /** `sha256:<64 lowercase hex>` — a candidate-manifest digest or a bare execution-tuple digest. */
  readonly digest: string;
}

/**
 * Substrate §5.1 — the frozen evidence input the proposer consumed. Cross-operator disclosure is
 * **digests-only**: no query text and no record content ever crosses the operator boundary
 * inside a manifest.
 *
 * `snapshotReceipt` mirrors evidence-retrieval's `QuerySnapshotReceipt` field-for-field and is
 * **mirrored, never imported** (substrate §2): the retrieval package's capabilities exceed what
 * a pure package may depend on.
 */
export interface CandidateEvidenceProvenance {
  readonly savedQueryDigest: string;
  readonly snapshotReceipt: QuerySnapshotReceiptMirror;
  /** Digest over the exact ordered record-reference list actually supplied. */
  readonly recordListDigest: string;
}

export interface CandidateSourceIdentityMirror {
  readonly id: string;
  readonly version: string;
}

export interface QuerySnapshotReceiptMirror {
  readonly savedQueryDigest: string;
  readonly sourceSet: CandidateSourceIdentityMirror;
  readonly sources: readonly {
    readonly source: CandidateSourceIdentityMirror;
    readonly checkpoint: {
      readonly source: CandidateSourceIdentityMirror;
      readonly value: JsonValue;
      readonly replayable: boolean;
    };
  }[];
  readonly evaluatedAt: string;
  readonly reproducibility: "replayable" | "not-replayable";
}

/** Substrate §5.1 — the proposer's claim of what changed relative to `parents`. Declared, not verified. */
export interface CandidateDeclaredChanges {
  readonly summary: string;
  readonly touchedComponents: readonly string[];
}

/** Substrate §5.1 — declared, not verified. */
export interface CandidateCompatibility {
  readonly taskProfiles?: readonly string[];
  readonly harnesses?: readonly string[];
  readonly models?: readonly string[];
}

/**
 * Substrate §5.1 — the candidate manifest. Carries **no score and no self-assessment**; whether
 * the candidate is better is established exclusively by subsequent evaluation records.
 *
 * Namespaced (reverse-DNS or absolute-URI) top-level extension keys are tolerated and preserved;
 * an unrecognized **non-namespaced** top-level field is rejected (§5.3).
 */
export interface CandidateManifest {
  readonly formatToken: string;
  readonly policy: ExecutionPolicyTuple;
  /** Empty for seeds; multiple parents allowed (crossover/composition). */
  readonly parents: readonly PolicyParentRef[];
  /** Agent IRI of the party that produced it. */
  readonly proposer: string;
  readonly evidenceProvenance: CandidateEvidenceProvenance;
  readonly declaredChanges: CandidateDeclaredChanges;
  readonly compatibility?: CandidateCompatibility;
  readonly [namespacedExtension: string]: unknown;
}

/** The output of `sealCandidateManifest` / `canonicalTupleBytes` + digest (substrate §5.2). */
export interface SealedDocument {
  readonly bytes: Uint8Array;
  /** `sha256:<64 lowercase hex>`. */
  readonly digest: string;
}

/**
 * Requirement entries as they appear on a Submission's run-pinning map — the output of
 * `expressAsRunPinning` (substrate §4.1's expression rule).
 */
export type RequirementEntries = Readonly<Record<string, JsonValue>>;

/** profiles §5.1 — mirrored, never imported (substrate §2). Type-bound by a kit test. */
export type ComparisonClass = "exact" | "ceiling" | "floor" | "constraint" | "addable";

/**
 * The subset of a resolved task-profile document the derivation needs (profiles §6.1).
 *
 * See FINDING F1 in `README.md`: the program's frozen signature
 * `deriveExecutionTuple(task, submission)` cannot execute substrate §4.1 steps 1–2 without it —
 * the comparison classes for profile-added keys and the closed key rule both live here, and the
 * profile is a separate sealed document that `Task.profile` only pins by digest.
 */
export interface ResolvedTaskProfile {
  readonly profile: string;
  /** `sha256:<64 lowercase hex>` — MUST equal the Task's `profile.digest.sha256`, prefixed. */
  readonly digest: string;
  readonly requirementKeys: readonly { readonly key: string; readonly comparisonClass: ComparisonClass }[];
}

/** A parsed sealed Task document (TEP §7.1). Only the fields the derivation reads are named. */
export interface SealedTaskDoc {
  readonly profile: { readonly uri?: string; readonly digest?: Readonly<Record<string, string>> };
  readonly requirements?: Readonly<Record<string, JsonValue>>;
  readonly [field: string]: unknown;
}

/** A parsed sealed Submission record (TEP §8). Only the fields the derivation reads are named. */
export interface SealedSubmissionDoc {
  readonly requirements?: Readonly<Record<string, JsonValue>>;
  readonly [field: string]: unknown;
}

/**
 * Typed rejection categories. Every one of these is **fail-closed**: the derivation and the
 * validator refuse rather than guess.
 */
export type PolicyIdentityErrorCategory =
  /** Structural rejection of an input document (TEP's spelling, reused). */
  | "invalid-document"
  /** Substrate §4.1 step 5 — a tuple missing a core axis key is invalid input, not a different identity. */
  | "omitted-core-axis"
  /** Substrate §4.1 step 1 — the Task/Submission requirements merge failed its comparison class. */
  | "requirement-conflict"
  /** Substrate §5.3 — an unrecognized non-namespaced top-level field. */
  | "unrecognized-field"
  /** Substrate §5.1 — a `parents[]` entry is not a well-formed typed reference. */
  | "malformed-parent"
  /** Substrate §5.1/§5.3 — `evidenceProvenance` missing or incomplete. */
  | "missing-provenance"
  /** Substrate §5.2 — the DSSE envelope / in-toto Statement does not bind to the manifest. */
  | "statement-binding"
  /** Substrate §4.2 — a `learner-public.v1` classification or fail-closed rule was violated. */
  | "hash-profile-violation"
  /** Substrate §4.2 — a package carries a profile-ignored root and must not be materialized. */
  | "materialization-refused";

export interface ValidationIssue {
  readonly path: string;
  readonly code: PolicyIdentityErrorCategory;
  readonly message: string;
}

export type ValidationResult =
  | { readonly ok: true; readonly manifest: CandidateManifest }
  | { readonly ok: false; readonly errors: readonly ValidationIssue[] };

/**
 * Substrate §7 — the per-axis treatment-fidelity tri-state. Mirrored here because the tuple's
 * consumers (`@jinn-network/policy-outcomes`, C2) key their per-axis counters on it. The
 * benchmarking design §8.1/§12.1 owns the derivation; this is vocabulary only.
 */
export type AxisFidelityStatus = "match" | "mismatch" | "unverifiable";

/** Substrate §4.3 — identity-strength tiers. Vocabulary only; nothing here computes them. */
export type IdentityStrength = "enforced" | "attested" | "vacuous";

/**
 * A `jinn.harness-state.v1` package described purely in memory. The kit is pure — it never
 * touches a filesystem — so `learner-public.v1` is exercised over this description instead of a
 * real tree. `content` is the file's exact UTF-8 text; `kind` distinguishes the entries the
 * profile fails closed on.
 */
export interface TreeEntry {
  readonly path: string;
  readonly kind: "file" | "symlink" | "special";
  readonly content?: string;
}
