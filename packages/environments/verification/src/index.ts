// SPDX-License-Identifier: Apache-2.0

export {
  DEFAULT_TIMEOUT_SECONDS,
  ENVIRONMENT_VERIFICATION_PREDICATE_TYPE,
  ENVIRONMENT_VERIFICATION_PROTOCOL_URI,
  MINIMUM_RUN_COUNT,
} from "./identifiers.js";
export {
  BareHexSha256Schema,
  DigestSetSchema,
  PrefixedSha256Schema,
  ResourceDescriptorSchema,
  fromDigestSet,
  toDigestSet,
  type DigestSet,
  type ResourceDescriptor,
} from "./digests.js";
export {
  ENVIRONMENT_VERIFICATION_ERROR_CODES,
  EnvironmentVerificationError,
  type EnvironmentVerificationErrorCode,
} from "./errors.js";
export {
  FAILURE_DISPOSITIONS,
  FAILURE_STAGES,
  VERIFICATION_FAILURE_REASONS,
  classifyVerificationFailure,
  stageForFailureReason,
  type FailureDisposition,
  type FailureStage,
  type VerificationFailureReason,
} from "./failures.js";
export {
  OUTCOME_STATUSES,
  OutcomeSetSchema,
  canonicalOutcomeSetBytes,
  outcomeSetDigest,
  outcomeSetsEqual,
  tallyOutcomeSet,
  type OutcomeSet,
  type OutcomeStatus,
  type OutcomeTally,
} from "./outcome-set.js";
export {
  EnvironmentVerificationPredicateSchema,
  parseEnvironmentVerificationPredicate,
  type EnvironmentVerificationPredicate,
  type VerificationControls,
  type VerifierIdentity,
} from "./predicate.js";
export {
  EnvironmentVerificationStatementSchema,
  attestationMatchesRecord,
  buildEnvironmentVerificationStatement,
  parseEnvironmentVerificationStatement,
  verifyBaselineCounts,
  type EnvironmentVerificationStatement,
} from "./statement.js";
export { buildEnvironmentVerificationSubjects } from "./subject.js";
export {
  DEFAULT_VERIFICATION_CONTROLS,
  verifyEnvironment,
  type SealedAttestation,
  type VerificationDeps,
  type VerifyEnvironmentOptions,
} from "./verify.js";
export type {
  ArtifactPutReceipt,
  ArtifactStore,
  Clock,
  CommandSpec,
  ContainerRunRequest,
  ContainerRunResult,
  ContainerRuntime,
  EnvironmentParserIdentity,
  ImagePullRequest,
  ImagePullResult,
} from "./ports.js";
