// SPDX-License-Identifier: Apache-2.0

export {
  CHAIN_ENVIRONMENT_VERIFICATION_PREDICATE_TYPE,
  CHAIN_ENVIRONMENT_VERIFICATION_PROTOCOL_URI,
  CHAIN_OBSERVATION_SCHEMA_ID,
  CHAIN_SOLUTION_MEDIA_TYPE,
  COMPOSITE_OBSERVATION_SCHEMA_ID,
  DEFAULT_PROBE_TIMEOUT_SECONDS,
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
  CHAIN_VERIFICATION_ERROR_CODES,
  ChainVerificationError,
  conformanceFailure,
  invalidInput,
  type ChainVerificationErrorCode,
} from "./errors.js";
export {
  BlockCommitmentSchema,
  CanonicalChainObservationSchema,
  CompositeObservationSchema,
  InformationPlaneObservationSchema,
  LogEntrySchema,
  PROBE_RECEIPT_STATUSES,
  ProbeOutcomeSchema,
  StateReadOutcomeSchema,
  StorageEntrySchema,
  TouchedStateEntrySchema,
  buildCanonicalChainObservation,
  buildCompositeObservation,
  canonicalChainObservationBytes,
  chainObservationDigest,
  chainObservationsEqual,
  compositeObservationBytes,
  compositeObservationDigest,
  type CanonicalChainObservation,
  type CompositeObservation,
  type InformationPlaneObservation,
  type ProbeOutcome,
  type StateReadOutcome,
  type TouchedStateEntry,
} from "./observation.js";
export {
  CHAIN_VERIFICATION_DISPOSITIONS,
  CHAIN_VERIFICATION_FAILURE_REASONS,
  CHAIN_VERIFICATION_OUTCOMES,
  CHAIN_VERIFICATION_STAGES,
  RUN_BEARING_OUTCOMES,
  classifyChainVerificationFailure,
  isRunBearingOutcome,
  outcomeForFailureReason,
  stageForFailureReason,
  type ChainVerificationDisposition,
  type ChainVerificationFailureReason,
  type ChainVerificationOutcome,
  type ChainVerificationStage,
  type RunBearingOutcome,
} from "./outcomes.js";
export {
  ANCHOR_AUTHENTICITY,
  BaselineBlockSchema,
  CLOSURE_CLASSES,
  CLOSURE_EVIDENCE_MODES,
  COMPONENT_ROLES,
  ChainEnvironmentVerificationPredicateSchema,
  CompositionEvidenceSchema,
  CostObservationsSchema,
  CoverageFailureSchema,
  CoverageObservationSchema,
  DivergenceSchema,
  EnvironmentObservationSchema,
  FIDELITY_CLASSES,
  FailureBlockSchema,
  IsolationEvidenceSchema,
  NetworkPolicyObservationSchema,
  ProviderObservationSchema,
  RunObservationSchema,
  RunsBlockSchema,
  RuntimeIdentityObservationSchema,
  SourceAnchorObservationSchema,
  VerificationWindowSchema,
  VerifierIdentitySchema,
  parseChainEnvironmentVerificationPredicate,
  type BaselineBlock,
  type ChainEnvironmentVerificationPredicate,
  type ClosureEvidenceMode,
  type CompositionEvidence,
  type CostObservations,
  type EnvironmentObservation,
  type FailureBlock,
  type IsolationEvidence,
  type RunObservation,
  type RunsBlock,
  type VerifierIdentity,
  type VerificationWindow,
} from "./predicate.js";
export {
  buildChainEnvironmentVerificationSubjects,
  buildCryptoEnvironmentVerificationSubjects,
  type ChainEnvironmentSubjectInput,
  type CryptoEnvironmentSubjectInput,
} from "./subject.js";
export {
  ChainEnvironmentVerificationStatementSchema,
  ComponentVerificationStatementSchema,
  CompositeVerificationStatementSchema,
  attestationMatchesRecord,
  buildChainEnvironmentVerificationStatement,
  buildCryptoEnvironmentVerificationStatement,
  parseChainEnvironmentVerificationStatement,
  requiresComponentAttestations,
  type ChainEnvironmentVerificationStatement,
} from "./statement.js";
export type {
  ArtifactPutReceipt,
  ArtifactStore,
  ChainProbeExecutionRequest,
  ChainProbeExecutionResult,
  ChainProbeExecutor,
  ChainRuntime,
  ChainVerificationDeps,
  Clock,
  InformationWorldRuntime,
  ResolvedResource,
} from "./ports.js";
export { DEFAULT_BLACKHOLE_POLICY } from "./ports.js";
export {
  canonicalResolutionLogBytes,
  resolutionLogDigest,
  resolveMaterials,
  type ResolutionRequest,
  type ResolutionResult,
} from "./resolve.js";
export {
  assessClosure,
  type ClosureAssessment,
  type ClosureAssessmentInput,
} from "./closure.js";
export {
  assessArtifactCoverage,
  type ArtifactEntryIndexInput,
  type CoverageAssessment,
  type CoverageAssessmentInput,
  type FixtureMutationDeclaration,
  type SourceProofManifest,
} from "./coverage.js";
export {
  verifyChainEnvironment,
  type SealedAttestation,
  type VerifyChainEnvironmentOptions,
} from "./verify.js";
export {
  ARCHIVE_NETWORK_POLICY,
  observeArchiveEnvironment,
  type ArchiveProviderSpec,
  type ObserveArchiveOptions,
} from "./archive.js";
export {
  assessOriginRouting,
  verifyCryptoEnvironment,
  type RoutingCollision,
  type RoutingEntry,
  type VerifyCryptoEnvironmentOptions,
} from "./composite.js";
export {
  AbiValueTypeSchema,
  decodeAbiReturn,
  encodeAbiCall,
  type AbiValue,
} from "./abi-encode.js";
export {
  StructuredReadRequestSchema,
  resolveStateReads,
  stateReadKey,
  type StructuredReadRequest,
} from "./state-reads.js";
export {
  loadAbiVectors,
  loadKeyCorpus,
  type AbiVector,
  type StateReadKeyEntry,
} from "./abi-vectors.js";
export {
  createAnvilMaterializer,
  type AnvilMaterializerConfig,
  type ChainInstance,
  type MaterializedChainInstance,
  type PinnedRuntimeIdentity,
  type VerifiedChainInstance,
  type VerifiedChainMaterializer,
} from "./anvil.js";
export { createProbeExecutor, type ProbeExecutorConfig } from "./probes.js";
export {
  createScriptReplayer,
  parseChainSolutionScript,
  SOLUTION_OPERATION_KINDS,
  type ChainScriptReplayer,
  type ScriptReplayerConfig,
} from "./replay.js";
export type {
  MaterializationSnapshot,
  ProcessHost,
  RpcTransport,
  SpawnedProcess,
  WorkspaceHost,
} from "./runtime-hosts.js";
export { MATERIALIZATION_SNAPSHOT_RPC } from "./runtime-hosts.js";
export {
  MAX_INFRASTRUCTURE_ATTEMPTS,
  STAGED_DISPOSITIONS,
  STAGED_STATE_SCHEMA_VERSION,
  STAGED_STAGES,
  advanceStagedJob,
  createStagedStateFile,
  dueStagedJobs,
  parseStagedStateFile,
  recordStagedAttested,
  recordStagedFailure,
  serializeStagedStateFile,
  upsertStagedJobs,
  type StagedDisposition,
  type StagedJob,
  type StagedStage,
  type StagedStateFile,
  type StagedStateStore,
} from "./staged-state.js";
export { createFileStagedStateStore } from "./staged-state-store.js";
