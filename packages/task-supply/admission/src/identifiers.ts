// SPDX-License-Identifier: Apache-2.0

/**
 * DSSE `payloadType` for a sealed receipt. The receipt is the *predicate* of an in-toto
 * Statement, so the envelope seals under the generic in-toto payload type — the exact value
 * `packages/marketplace/binding/src/named-checks.ts` requires of an admission receipt
 * (`VERDICT_DSSE_PAYLOAD_TYPE`). Design §7.1: this unit conforms to the existing contract
 * rather than defining a new one.
 */
export const ADMISSION_RECEIPT_MEDIA_TYPE = "application/vnd.in-toto+json" as const;

/** in-toto Statement `_type`, mirrored structurally (never imported across trees). */
export const IN_TOTO_STATEMENT_TYPE = "https://in-toto.io/Statement/v1" as const;

/** Receipt kind — spec §15's `DifferentialAdmissionReceipt/3`, as a URI. */
export const ADMISSION_RECEIPT_SCHEMA_VERSION =
  "https://spec.jinn.network/records/differential-admission-receipt/v3" as const;

/** in-toto `predicateType` of the Statement whose predicate is the receipt. */
export const DIFFERENTIAL_ADMISSION_PREDICATE_TYPE =
  "https://spec.jinn.network/attestations/differential-admission/v3" as const;

/**
 * The public, versioned evidence policy this package implements (design §7.1). It is a policy
 * about *this* candidate's grader, and says nothing about the environment beyond the record
 * digest it names.
 */
export const DIFFERENTIAL_ADMISSION_POLICY_V3 = {
  admissionPolicyVersion: "https://spec.jinn.network/task-admission/policy/v3",
  /** Repeats per side, per path: empty x2 and gold x2. */
  observationsPerSide: 2,
  /** The candidate's declared transitions must be the ones its EvaluationSpec grades against. */
  requireCandidateSpecConsistency: true,
  /** …and the ones its own observations prove (design §7.1, first bullet). */
  requireDeclaredTransitionsProven: true,
  /** An assertion counts as fail-to-pass only if the empty side observed it *failing*. */
  requireEmptySideFailure: true,
  requireFailToPassPerPath: true,
  requireGloballyUniqueAssertionIds: true,
  requireInlineEnvironmentMatch: true,
} as const;

/**
 * Namespaced EvaluationSpec extension key carrying the environment-record reference
 * (design §7.2). Declared here because admission enforces it; the derivation unit writes it.
 * See Finding F-C3-3.
 */
export const ENVIRONMENT_RECORD_SPEC_KEY = "network.jinn.environment.record" as const;

/**
 * Submission annotation URI under which a sealed receipt is referenced, and the descriptor
 * `name` the evaluation leg requires. Byte-identical counterparts live in
 * `packages/marketplace/binding/src/evaluation-derive.ts`; that tree is outside this package's
 * import boundary (design §3.3), so the strings are pinned by test, not shared by import.
 */
export const ADMISSION_RECEIPT_ANNOTATION_URI =
  "https://spec.jinn.network/annotations/admission-receipt/v1" as const;
export const ADMISSION_RECEIPT_DESCRIPTOR_NAME = "admission-receipt" as const;

/** Receipt kind for the state-predicate family's admission receipt (chain design §6.3). */
export const CHAIN_ADMISSION_RECEIPT_SCHEMA_VERSION =
  "https://spec.jinn.network/records/chain-admission-receipt/v1" as const;

/** in-toto `predicateType` of the Statement whose predicate is a chain admission receipt. */
export const CHAIN_ADMISSION_PREDICATE_TYPE =
  "https://spec.jinn.network/attestations/chain-admission/v1" as const;

/**
 * The public, versioned evidence policy the chain entry point implements (chain design
 * §6.3). It is a policy about THIS candidate's grader and says nothing about the
 * environment beyond the composite digest it names — the same bound the SWE policy carries.
 */
export const CHAIN_ADMISSION_POLICY_V1 = {
  admissionPolicyVersion: "https://spec.jinn.network/task-admission/policy/chain/v1",
  /** Repeats per side: do-nothing x2 and reference x2, each on a fresh instance. */
  observationsPerSide: 2,
  /** The do-nothing check is over the success CONJUNCTION, never over individual predicates. */
  requireDoNothingConjunctionFalse: true,
  requireReferenceConjunctionTrue: true,
  requireReferenceSafetyUnviolated: true,
  /** The reference path must execute entirely inside the committed world (design §6.3). */
  requireReferenceSliceSufficient: true,
  requireRepeatStableObservations: true,
  /** The reference script is recorded as a digest; its content never enters a receipt. */
  requireReferenceScriptDigestOnly: true,
} as const;
