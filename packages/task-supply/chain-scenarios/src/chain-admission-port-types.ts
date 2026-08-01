// SPDX-License-Identifier: Apache-2.0

/**
 * Structural admission port types until Task 13 exports them from
 * `@jinn-network/task-admission`. `run.ts` imports these via a single `import type` shim.
 */

export interface ChainAdmissionCandidate {
  readonly taskDocumentDigest: `sha256:${string}`;
  readonly statementDigest: `sha256:${string}`;
  readonly referenceScriptDigest: `sha256:${string}`;
  readonly evaluationSpecBytes: Uint8Array;
  readonly evalSemanticsVersion: string;
}

export type ChainAdmissionRefusalCode =
  | "do-nothing-satisfies"
  | "env-record-mismatch"
  | "execution-failed"
  | "inconsistent-observation"
  | "invalid-candidate"
  | "reference-unsatisfied"
  | "safety-violated"
  | "slice-insufficient"
  | "unstable-observations";

export interface ChainAdmissionRefusal {
  readonly code: ChainAdmissionRefusalCode;
  readonly detail: string;
}

export interface ChainAdmissionReceiptV1 {
  readonly schemaVersion: string;
  readonly admissionPolicyVersion: string;
  readonly family: "state-predicate";
  readonly issuer: string;
  readonly task: {
    readonly documentDigest: `sha256:${string}`;
    readonly evaluationSpecDigest: `sha256:${string}`;
    readonly statementDigest: `sha256:${string}`;
  };
  readonly referenceScriptDigest: `sha256:${string}`;
  readonly observations: {
    readonly doNothing: readonly unknown[];
    readonly reference: readonly unknown[];
  };
  readonly environment: { readonly compositeRecordDigest: `sha256:${string}` };
  readonly sliceSufficiency: { readonly referenceOutOfSliceReads: 0 };
  readonly evalSemanticsVersion: string;
}

export type ChainAdmissionResult =
  | { readonly receipt: ChainAdmissionReceiptV1 }
  | { readonly refusal: ChainAdmissionRefusal };
