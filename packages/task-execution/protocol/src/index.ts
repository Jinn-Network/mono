// @jinn-network/task-execution-protocol — public surface (frozen at the §22 granularity).
// Pure, I/O-free reference implementation of the Jinn Task Execution Protocol v1.

export const TASK_EXECUTION_PROTOCOL_URI =
  "https://jinn.network/profiles/task-execution/1.0";

// --- sealing primitives (order, hashing, canonicalization, I-JSON) ---
export { compareCodeUnitStrings } from "./order.js";
export { documentDigest, sha256Hex } from "./hashing.js";
export { serializeCanonicalJson } from "./canonical.js";
export { IJsonNumberError, assertIJsonInteger } from "./json.js";
export type { JsonValue } from "./json.js";

// --- descriptors + structural evidence seam ---
export { resourceDescriptorHasLocator } from "./descriptors.js";
export type { EvidenceRecordFamily, EvidenceRecordReference, ResourceDescriptor } from "./descriptors.js";

// --- identity: deterministic Attempt-URI derivation (§9.2, program §7.2) ---
export { TEP_ATTEMPT_NAMESPACE, deriveAttemptUri, isValidUrnUuid } from "./identifiers.js";

// --- family schemas (zod) ---
export {
  DigestMapSchema,
  EFFORT_TIERS,
  EVIDENCE_RECORD_FAMILIES,
  EffortTierSchema,
  EvidenceRecordReferenceSchema,
  HarnessPinSchema,
  IsolationPolicySchema,
  LoadoutSchema,
  ModelPinSchema,
  PreferencesMap,
  RequirementsMap,
  ResourceDescriptorSchema,
  Rfc3339,
  Sha256Digest,
  UrnUuid,
} from "./schemas/common.js";
export type { EffortTier } from "./schemas/common.js";

export { TaskOutputSlotSchema, TaskSpecificationSchema } from "./schemas/task.js";
export type { TaskSpecification } from "./schemas/task.js";

export { SubmissionRecordSchema } from "./schemas/submission.js";
export type { SubmissionRecord } from "./schemas/submission.js";

export { DeliveryRecordSchema } from "./schemas/delivery.js";
export type { DeliveryRecord } from "./schemas/delivery.js";

export { DispatchContextSchema } from "./schemas/dispatch-context.js";
export type { DispatchContext } from "./schemas/dispatch-context.js";

export {
  ATTEMPT_OBSERVATION_TYPES,
  OBSERVATION_TYPES,
  ProtocolObservationSchema,
  SUBMISSION_OBSERVATION_TYPES,
} from "./schemas/observation.js";
export type { ProtocolObservation } from "./schemas/observation.js";

// --- validators ---
export {
  validateDelivery,
  validateDispatchContext,
  validateObservation,
  validateSubmission,
  validateTask,
} from "./validators.js";
export type { ValidationIssue, ValidationResult } from "./validators.js";

// --- error, event, and Attempt-state vocabularies (§13/§10.2/§10.3) ---
export { ERROR_RETRYABLE, TASK_EXECUTION_ERROR_CATEGORIES, isRetryable } from "./errors.js";
export type { TaskExecutionErrorCategory } from "./errors.js";

export {
  ATTEMPT_EVENT_TYPES,
  MAX_SEQUENCE,
  SUBMISSION_EVENT_TYPES,
  TASK_EXECUTION_EVENT_TYPES,
  formatSequence,
} from "./events.js";

export { ATTEMPT_STATES, TERMINAL_STATES } from "./states.js";
export type { AttemptState, FailureBlame } from "./states.js";

// --- the observation fold (§10.4) + the Attempt projection (§9/§22) ---
export { foldObservations } from "./fold.js";
export type { AttemptDescriptor, DerivedAttemptState, FoldObservationsOptions } from "./fold.js";

// --- sealing entry points (§6.1) ---
export { InvalidDocumentError, sealDelivery, sealSubmission, sealTask } from "./sealing.js";

// --- requirements/run-pinning merge (carried amendment 1, program §7.3) ---
export { mergeRequirements } from "./requirements.js";
export type { ComparisonClass, EffectiveRequirements, MergeRequirementsResult } from "./requirements.js";

// --- fixture loaders (golden + adversarial, §24) ---
export {
  loadAdversarialManifest,
  loadEquivalenceExpectedDigest,
  loadEquivalenceTaskBytes,
  loadGoldenConformanceReport,
  loadGoldenDeliveryBytes,
  loadGoldenObservations,
  loadGoldenSubmissionBytes,
  loadGoldenTaskBytes,
  readAdversarialFile,
  readAdversarialJson,
} from "./fixtures.js";
export type {
  AdversarialManifest,
  AdversarialManifestEntry,
  GoldenConformanceReport,
  GoldenScenario,
} from "./fixtures.js";
