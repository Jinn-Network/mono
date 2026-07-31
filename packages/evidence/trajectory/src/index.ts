// SPDX-License-Identifier: Apache-2.0

// Pinned identifiers
export {
  TRAJECTORY_MEDIA_TYPE,
  TRAJECTORY_PROTOCOL,
  TRAJECTORY_RECORD_KIND,
  TRAJECTORY_VOCABULARY_PROFILE,
  TRAJECTORY_DERIVATION_PREDICATE_TYPE,
  TRAJECTORY_SUBJECT_NAME,
  TRAJECTORY_RECORD_IDENTIFIER_PROPERTY,
  LINKAGE_MODES,
} from "./identifiers.js";
export type { LinkageMode } from "./identifiers.js";
export {
  GEN_AI_ATTRIBUTES,
  JINN_ATTRIBUTES,
  OPERATION_NAMES,
  VOCABULARY_UPSTREAM,
  isAdmittedAttributeKey,
} from "./vocabulary.js";
export type { GenAiAttributeKey, JinnAttributeKey } from "./vocabulary.js";
export { TIMEBASES } from "./timebase.js";
export type { Timebase } from "./timebase.js";

// Digest forms
export {
  toBareSha256Hex,
  toRepositorySha256Digest,
} from "./digests.js";
export type { BareSha256Hex, RepositorySha256Digest } from "./digests.js";

// Sealing primitives
export { compareCodeUnitStrings } from "./order.js";
export {
  NonIJsonNumberError,
  NonIJsonStringError,
  UndefinedArrayElementError,
  UnsupportedCanonicalValueError,
  serializeCanonicalJson,
} from "./canonical.js";
export type { JsonValue } from "./canonical.js";
export { documentDigest, sha256Hex } from "./hashing.js";
export {
  InvalidDocumentError,
  parseExactWithSchema,
  sealRecord,
  sealWithSchema,
} from "./sealing.js";
export type { SealedRecord, ValidationIssue } from "./sealing.js";

// Derived identity
export { deriveSpanId, deriveTraceId } from "./identity.js";
export type { TraceIdInput } from "./identity.js";

// Record kind
export { isNamespacedExtensionKey, topLevelRecordSchema, closedObjectSchema, JsonExtensionValueSchema } from "./extensions.js";
export type { JsonExtensionValue } from "./extensions.js";
export {
  AnyValueSchema,
  AttributeSchema,
  SPAN_KIND,
  STATUS_CODE,
  SpanEventSchema,
  SpanSchema,
  SpanStatusSchema,
} from "./span.js";
export type { AnyValue, Attribute, Span, SpanEvent, SpanStatus } from "./span.js";
export { TrajectoryRecordSchema, parseTrajectory, sealTrajectory } from "./schema.js";
export type { TrajectoryRecord } from "./schema.js";

// Derivation attestation
export {
  buildTrajectoryDerivationStatement,
  sealTrajectoryDerivationAttestation,
  verifyTrajectoryDerivationAttestation,
  TrajectoryDerivationCancelledError,
} from "./derivation.js";
export type {
  BuildTrajectoryDerivationStatementInput,
  SealedTrajectoryDerivationAttestation,
  SealTrajectoryDerivationAttestationInput,
  TrajectoryDerivationAuthorityVerifier,
  TrajectoryDerivationAuthorityVerifierInput,
  TrajectoryDerivationAuthorityVerifierResult,
  TrajectoryDerivationLayerOutcome,
  TrajectoryDerivationPredicate,
  TrajectoryDerivationStatement,
  TrajectoryDerivationVerificationLayers,
  TrajectoryDerivationVerificationResult,
  VerifyTrajectoryDerivationAttestationInput,
} from "./derivation.js";
export { preflightCanonicalInput } from "./preflight.js";
