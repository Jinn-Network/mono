// SPDX-License-Identifier: Apache-2.0

export type { CapabilityContext, RuntimeCapability } from "./capability.js";
export {
  ENVIRONMENT_KEYS,
  RuntimeConfigFileSchema,
  resolveRuntimeConfig,
} from "./config.js";
export type { RuntimeConfig, RuntimeConfigFile, RuntimeConfigSource } from "./config.js";
export { PluginRuntimeError, RUNTIME_ERROR_CODES } from "./errors.js";
export type { RuntimeErrorCode } from "./errors.js";
export { summarizeHealth } from "./health.js";
export type { HealthCheck, HealthReport } from "./health.js";
export { createLineLogger, createSilentLogger } from "./logger.js";
export type { LogLevel, RuntimeLogger } from "./logger.js";
export { createPluginRuntime } from "./runtime.js";
export type { PluginRuntime, PluginRuntimeOptions } from "./runtime.js";
export { RUNTIME_VERSION } from "./version.js";
export * from "./corpus/index.js";

// Capture
export { ARCHIVE_BUSY_ERROR_CODE, withCaptureArchive } from "./capture/archive.js";
export type { CaptureArchiveOptions } from "./capture/archive.js";
export {
  buildFinalizeInput,
  buildStartInput,
  resolveSessionOutcome,
  sessionSummary,
} from "./capture/assemble.js";
export type { CaptureAssemblyInput, SessionOutcome } from "./capture/assemble.js";
export { createCaptureCapability } from "./capture/capability.js";
export type {
  CaptureCapability,
  CreateCaptureCapabilityOptions,
  OpenSessionInput,
  OpenSessionResult,
  SealSessionInput,
  SealSessionResult,
  SealedCapture,
} from "./capture/capability.js";
export {
  CONTROLLED_INPUT_MAX_BYTES,
  CONTROLLED_INPUT_MAX_COUNT,
  CONTROLLED_INPUT_ROLES,
  parseSessionFeed,
} from "./capture/feed.js";
export type {
  AbsoluteIriString,
  AssistantTurnEvent,
  ControlledInput,
  ControlledInputEvent,
  ControlledInputRole,
  FeedLine,
  ParsedSessionFeed,
  RepositoryStateEvent,
  SessionCloseEvent,
  SessionFeedEvent,
  SessionOpenEvent,
  ToolCallEvent,
  UserTurnEvent,
} from "./capture/feed.js";
export {
  BASE_COMMIT_PROPERTY,
  BASE_TREE_PROPERTY,
  BRANCH_PROPERTY,
  CAPTURE_LICENSE,
  CONTROLLED_INPUT_ROLE_PROPERTY,
  MODEL_SERVICE_ENTITY_ID,
  PRODUCER_IRI,
  PRODUCER_NAME,
  REPOSITORY_BASE_STATE_ENTITY_ID,
  REPOSITORY_STATE_ENTITY_ID,
  SESSION_FEED_FORMAT_IRI,
  SESSION_FEED_MEDIA_TYPE,
  SESSION_FEED_VERSION,
  SESSION_ID_PROPERTY,
  TARGET_BASE_PROPERTY,
  TRACE_BUILDER_ID,
  TRACE_BUILDER_VERSION,
  TRACE_RECORD_IDENTIFIER_PROPERTY,
  controlledInputEntityId,
  executorIri,
} from "./capture/identity.js";
export {
  derivationLinkPath,
  loadTraceDerivationAttestation,
  loadTraceRecord,
  readTraceDerivationAttestationLink,
  traceReferenceFromRecordBytes,
  writeTraceDerivationAttestationLink,
} from "./capture/link.js";
export type { TraceDerivationAttestationLink } from "./capture/link.js";
export {
  assertSafeSessionId,
  ensureOwnerOnlyDirectory,
  ensureOwnerOnlyFile,
  resolveCapturePaths,
  sessionDirectory,
  sessionFeedPath,
  workspaceDirectory,
} from "./capture/paths.js";
export type { CapturePaths } from "./capture/paths.js";
export {
  RETENTION_POLICY_STATEMENT,
  SEAL_MARKER_FILENAME,
  listStrandedSessionIds,
  readRetentionWatermark,
  sweepCaptureRetention,
} from "./capture/retention.js";
export type {
  CaptureRetentionReport,
  RetentionWatermark,
  SweepCaptureRetentionInput,
} from "./capture/retention.js";
export { buildTraceSpans } from "./capture/spans.js";
export type { BuildTraceSpansInput } from "./capture/spans.js";
export {
  TRACE_ARTIFACT_MEDIA_TYPE,
  buildTraceRecord,
} from "./capture/trace.js";
export type { BuiltTrace } from "./capture/trace.js";

// C6 — relevance, sensitivity exclusion, and projection.
export { PLANES, comparePlanes } from "./relevance/planes.js";
export type { EvidencePlane } from "./relevance/planes.js";
export {
  STOPWORDS,
  deriveRepositorySearchTerms,
  deriveSearchTerms,
  discriminatingTerms,
} from "./relevance/terms.js";
export {
  MAX_BODY_CHARS,
  MAX_EXCERPT_CHARS,
  MAX_INDEXED_EXCERPTS,
  MAX_SUMMARY_CHARS,
  openRelevanceIndex,
} from "./relevance/index-store.js";
export type {
  ExcerptLabel,
  ExcludedExcerpt,
  IndexReceipt,
  IndexStats,
  IndexableExcerpt,
  IndexableRecord,
  RelevanceIndex,
  RelevanceIndexOptions,
} from "./relevance/index-store.js";
export {
  BODY_TERM_WEIGHT,
  DEFAULT_SEARCH_LIMIT,
  RELEVANCE_FLOOR,
  SUMMARY_TERM_WEIGHT,
} from "./relevance/search.js";
export type {
  ProjectableExcerpt,
  RankedCandidate,
  RelevanceQuery,
} from "./relevance/search.js";
export {
  DETECTOR_FAILURE_CLASS,
  EXCLUDING_BANDS,
  SENSITIVE_CLASSES,
  createSensitivityClassifier,
} from "./relevance/sensitivity.js";
export type {
  SensitivityClassifier,
  SensitivityClassifierOptions,
  SensitivityVerdict,
} from "./relevance/sensitivity.js";
export { createTraceSpanSource } from "./relevance/trace-decode-adapter.js";
export type { TraceSpanRequest, TraceSpanSource } from "./relevance/trace-decode-adapter.js";
export {
  indexLocalPlane,
  indexLocalRecord,
  indexPublicPlane,
  rebuildIndex,
} from "./relevance/indexing.js";
export type { IndexingDeps, IndexingReport } from "./relevance/indexing.js";
export {
  DEFAULT_PROJECTION_MAX_CHARS,
  DEFAULT_PROJECTION_MAX_RECORDS,
  PROVENANCE_PREAMBLE,
  projectContext,
  renderFencedBlock,
} from "./projection/project.js";
export type {
  ProjectedExcerpt,
  ProjectedRecord,
  ProjectionBudget,
  ProjectionResult,
} from "./projection/project.js";
export { FENCE_PREFIX, QUOTE_PREFIX, deriveFence, quoteBlock } from "./projection/fence.js";
export { TRUNCATION_TAIL, truncateLineBoundary } from "./projection/truncate.js";
export { runPickup } from "./pickup.js";
export type { PickupDeps, PickupRequest } from "./pickup.js";
export { createCorpusAdmissionFilter } from "./relevance/admission.js";
export type { AdmissionFilter, CorpusAdmission } from "./relevance/admission.js";

// `bin.ts` is deliberately NOT re-exported: it reads the ambient environment, installs
// signal handlers, and runs on import as a process entry point. Re-exporting it would
// pull all three into every consumer.
