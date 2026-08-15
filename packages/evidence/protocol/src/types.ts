import type {
  DsseEnvelope,
  ExecutionEvidenceDocument,
  ExecutionVerificationStatement,
  ResultEvaluationStatement,
} from "./schemas.js";

export const CONFORMANCE_DIAGNOSTIC_CODES = [
  "JSON_INVALID",
  "UTF8_INVALID",
  "SCHEMA_INVALID",
  "ROCRATE_CONTEXT_INVALID",
  "ROCRATE_GRAPH_INVALID",
  "ROCRATE_ENTITY_ID_MISSING",
  "ROCRATE_ENTITY_ID_DUPLICATE",
  "ROCRATE_ENTITY_TYPE_MISSING",
  "ROCRATE_REFERENCE_INVALID",
  "ROCRATE_METADATA_DESCRIPTOR_CARDINALITY",
  "ROCRATE_ROOT_CARDINALITY",
  "ROCRATE_ROOT_FIELDS_INVALID",
  "PROFILE_DECLARATION_MISSING",
  "PROFILE_CONTEXTUAL_ENTITY_MISSING",
  "EXECUTION_CARDINALITY",
  "TASK_CARDINALITY",
  "EXECUTOR_AGENT_CARDINALITY",
  "AGENT_IRI_INVALID",
  "RUNTIME_SPECIFICATION_CARDINALITY",
  "RUNTIME_COMPONENT_BINDING_MISSING",
  "EXECUTION_RELATION_INVALID",
  "EXECUTION_STATUS_INVALID",
  "EXECUTION_COMPLETED_RESULT_MISSING",
  "TRACE_CARDINALITY",
  "DURATION_MISSING",
  "ARTIFACT_SHA256_MISSING",
  "ARTIFACT_SHA256_INVALID",
  "AGGREGATE_MANIFEST_INVALID",
  "CAPTURE_PROVENANCE_MISSING",
  "DERIVATION_PROVENANCE_INVALID",
  "DERIVATIVE_ROLE_SUBSTITUTION",
  "ATTESTATION_ENVELOPE_INVALID",
  "ATTESTATION_PAYLOAD_TYPE_INVALID",
  "ATTESTATION_PAYLOAD_INVALID",
  "ATTESTATION_SIGNATURE_MISSING",
  "ATTESTATION_STATEMENT_INVALID",
  "ATTESTATION_SUBJECT_INVALID",
  "EVALUATION_SUBJECT_BINDING_INVALID",
  "VERIFICATION_SUBJECT_BINDING_INVALID",
  "RESOURCE_DESCRIPTOR_INVALID",
  "CORRECTION_REFERENCE_INVALID",
] as const;

export type ConformanceDiagnosticCode =
  (typeof CONFORMANCE_DIAGNOSTIC_CODES)[number];

export interface ConformanceDiagnostic {
  readonly code: ConformanceDiagnosticCode;
  readonly path: string;
  readonly message: string;
  readonly entityId?: string;
}

export interface ValidationReport<T> {
  readonly conforms: boolean;
  readonly recordDigest: `sha256:${string}`;
  readonly value?: T;
  readonly diagnostics: readonly ConformanceDiagnostic[];
}

export interface ResultEvaluationEvidence {
  readonly envelope: DsseEnvelope;
  readonly statement: ResultEvaluationStatement;
  readonly payloadBytes: Uint8Array;
}

export interface ExecutionVerificationEvidence {
  readonly envelope: DsseEnvelope;
  readonly statement: ExecutionVerificationStatement;
  readonly payloadBytes: Uint8Array;
}

export type ArtifactIntegrityStatus =
  | "verified"
  | "mismatch"
  | "unavailable";

export interface ArtifactIntegrityEntry {
  readonly entityId: string;
  readonly expectedDigest: `sha256:${string}`;
  readonly status: ArtifactIntegrityStatus;
  readonly actualDigest?: `sha256:${string}`;
}

export interface ArtifactIntegrityReport {
  readonly artifacts: readonly ArtifactIntegrityEntry[];
  readonly verified: number;
  readonly mismatched: number;
  readonly unavailable: number;
}

export interface DsseSignatureInput {
  readonly payloadType: string;
  readonly payloadBytes: Uint8Array;
  readonly preAuthEncoding: Uint8Array;
  readonly signature: Uint8Array;
  readonly keyid?: string;
  readonly signatureIndex: number;
}

export type DsseSignatureVerifier = (
  input: DsseSignatureInput,
) => boolean | Promise<boolean>;

export interface DsseSignatureResult {
  readonly signatureIndex: number;
  readonly keyid?: string;
  readonly verified: boolean;
  readonly error?: string;
}

export interface DsseSignatureReport {
  readonly verified: boolean;
  readonly signatures: readonly DsseSignatureResult[];
}

export type { ExecutionEvidenceDocument };
