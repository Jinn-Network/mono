// SPDX-License-Identifier: Apache-2.0

import type {
  ExecutionVerificationEvidence,
  ResultEvaluationEvidence,
} from "@jinn-network/evidence-protocol";
import type {
  EvidenceRecordReference,
  EvidenceRepository,
  RepositoryWriteReceipt,
  Sha256Digest,
} from "@jinn-network/evidence-repository";

export type JsonScalar = string | number | boolean | null;
export type JsonValue =
  | JsonScalar
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface AttestationIssuerOperationOptions {
  readonly signal?: AbortSignal;
}

export interface AttestationResourceReference {
  readonly name: string;
  readonly digest: Sha256Digest;
  readonly uri?: string;
  readonly mediaType?: string;
  readonly annotations?: Readonly<Record<string, JsonValue>>;
  readonly extensions?: Readonly<Record<string, JsonValue>>;
}

export interface AttestationAgentReference {
  readonly id: string;
  readonly extensions?: Readonly<Record<string, JsonValue>>;
}

export interface EvaluationMeasurement {
  readonly name: string;
  readonly value: JsonScalar;
  readonly unit?: string;
  readonly annotations?: Readonly<Record<string, JsonValue>>;
  readonly extensions?: Readonly<Record<string, JsonValue>>;
}

export interface VerificationCheck {
  readonly name: string;
  readonly status: "pass" | "fail" | "unknown";
  readonly explanation?: string;
  readonly evidence?: readonly AttestationResourceReference[];
  readonly annotations?: Readonly<Record<string, JsonValue>>;
  readonly extensions?: Readonly<Record<string, JsonValue>>;
}

export interface PrepareResultEvaluationInput {
  readonly task: AttestationResourceReference;
  readonly results: readonly [
    AttestationResourceReference,
    ...AttestationResourceReference[],
  ];
  readonly evaluator: AttestationAgentReference;
  readonly evaluatedAt: string;
  readonly verdict: "pass" | "fail" | "inconclusive";
  readonly evaluationSpecification?: AttestationResourceReference;
  readonly evaluationMethod?: AttestationResourceReference;
  readonly measurements?: readonly EvaluationMeasurement[];
  readonly evidence?: readonly AttestationResourceReference[];
  readonly explanation?: string;
  readonly limitations?: readonly string[];
  readonly supersedes?: readonly AttestationResourceReference[];
  readonly disputes?: readonly AttestationResourceReference[];
  readonly statementExtensions?: Readonly<Record<string, JsonValue>>;
  readonly predicateExtensions?: Readonly<Record<string, JsonValue>>;
}

export interface PrepareExecutionVerificationInput {
  readonly executionEvidenceDigest: Sha256Digest;
  readonly executionId: string;
  readonly verifier: AttestationAgentReference;
  readonly verifiedAt: string;
  readonly verdict: "verified" | "rejected" | "inconclusive";
  readonly verificationPolicy?: AttestationResourceReference;
  readonly verificationMethod?: AttestationResourceReference;
  readonly checks?: readonly VerificationCheck[];
  readonly explanation?: string;
  readonly limitations?: readonly string[];
  readonly supersedes?: readonly AttestationResourceReference[];
  readonly disputes?: readonly AttestationResourceReference[];
  readonly statementExtensions?: Readonly<Record<string, JsonValue>>;
  readonly predicateExtensions?: Readonly<Record<string, JsonValue>>;
}

export interface DsseSigningRequest {
  readonly payloadType: string;
  readonly payloadBytes: Uint8Array;
  readonly preAuthEncoding: Uint8Array;
  readonly signal?: AbortSignal;
}

export interface DsseProducedSignature {
  readonly signature: Uint8Array;
  readonly keyid?: string;
}

export type DsseSigner = (
  request: DsseSigningRequest,
) => Promise<readonly [DsseProducedSignature, ...DsseProducedSignature[]]>;

export interface PreparedAttestation<
  TFamily extends "result-evaluation" | "execution-verification",
  TValue,
> {
  readonly family: TFamily;
  readonly recordDigest: Sha256Digest;
  readonly envelopeBytes: Uint8Array;
  readonly payloadBytes: Uint8Array;
  readonly value: TValue;
}

export type PreparedResultEvaluation = PreparedAttestation<
  "result-evaluation",
  ResultEvaluationEvidence
>;
export type PreparedExecutionVerification = PreparedAttestation<
  "execution-verification",
  ExecutionVerificationEvidence
>;
export type AnyPreparedAttestation =
  | PreparedResultEvaluation
  | PreparedExecutionVerification;

export interface AttestationCommitReceipt<
  TFamily extends "result-evaluation" | "execution-verification",
> {
  readonly family: TFamily;
  readonly recordDigest: Sha256Digest;
  readonly repositoryReceipt: RepositoryWriteReceipt<EvidenceRecordReference>;
}

export type { EvidenceRepository };
