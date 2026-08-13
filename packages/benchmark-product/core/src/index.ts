/**
 * The product core's public surface.
 *
 * The operations facade is the single trusted boundary (spec §5.1): all validation,
 * authority checks, lifecycle transitions, and audit-journal appends live behind it,
 * and every surface — the CLI and the shipped private GUI — is a client of it.
 * The domain vocabulary (draft schemas, lifecycle machine, typed errors) is exported
 * so clients can render and reason about product state without re-deriving it.
 */

export type { ProductBranding } from "./branding.js";
export { PRODUCT_BRANDING } from "./branding.js";
export { BENCHMARKING_PROTOCOL } from "./platform.js";
export { OPERATION_TO_GUI as GUI_CAPABILITY_CATALOG } from "./cli/parity-map.js";
export type { GuiCapability } from "./cli/parity-map.js";

// Typed errors (spec §4.3): callers branch on `code`, never on `message`.
export { BenchmarkProductError, PRODUCT_ERROR_CODES, toErrorEnvelope } from "./errors.js";
export type { ProductErrorCode, ProductErrorEnvelope, ProductIssue } from "./errors.js";

// Lifecycle state machine (spec §4.1).
export {
  LIFECYCLE_EVENTS,
  LIFECYCLE_STATES,
  LifecycleStateSchema,
  isDraftMutable,
  transition,
} from "./domain/lifecycle.js";
export type { LifecycleEvent, LifecycleState, TransitionResult } from "./domain/lifecycle.js";

// Draft domain model (spec §4.5 mutable drafts; §6 assurance presets).
export {
  ASSURANCE_PRESETS,
  ArmIdSchema,
  ArmSchema,
  AssurancePresetSchema,
  AssuranceSchema,
  BudgetSchema,
  DRAFT_SPEC_DEFAULTS,
  DraftDocumentSchema,
  DraftIdSchema,
  DraftPolicySchema,
  DraftSpecSchema,
  EvaluationRuntimeBindingSchema,
  PinningSchema,
  TaskSetSchema,
  VenueSchema,
  draftIdFromName,
  parseDraftDocument,
  parseDraftSpec,
  resolveAssurance,
} from "./domain/draft.js";
export type {
  Assurance,
  AssurancePreset,
  DraftDocument,
  DraftSpec,
  EvaluationRuntimeBinding,
  ResolvedAssurance,
} from "./domain/draft.js";

// Runtime-neutral adapter catalog. Lifecycle state stores only an opaque digest-bound binding.
export {
  NATIVE_RUNTIME_ADAPTER_ID,
  NATIVE_RUNTIME_EVIDENCE_PROFILE,
  INSPECT_RUNTIME_EVIDENCE_PROFILE,
  INSPECT_EVAL_LOG_ARTIFACT_ROLE,
  INSPECT_SELECTION_CORRELATION_ROLE,
  INSPECT_RUNTIME_PROVENANCE_ROLE,
  createRuntimeEvidenceAdapter,
  createRuntimeVenue,
  listRuntimeAdapters,
  runtimeSubmissionBaseline,
  runtimeNativeArtifactPublicationPolicy,
} from "./runtime/adapter.js";
export type { EvaluationRuntimeAdapter, RuntimeAdapterSummary, RuntimeEvidenceAdapterOptions, RuntimeEvidenceDispatchInput, RuntimePublicationAdapter } from "./runtime/adapter.js";
export { createDefaultBenchmarkRuntimeHost } from "./runtime/host-port.js";
export type {
  BenchmarkRuntimeHost,
  BenchmarkRuntimeHostOptions,
  OpenAIHostConnection,
  InspectRuntimeSelectionRequest,
  InspectRuntimeSelectionResolution,
} from "./runtime/host-port.js";
export {
  HARBOR_SELECTION_SCHEMA,
  SUPPORTED_HARBOR_VERSION_RANGE,
  HarborSelectionManifestSchema,
  harborSelectionManifestBytes,
  harborSelectionManifestSha256,
  assertSupportedHarborVersion,
} from "./runtime/harbor/manifest.js";
export { HARBOR_ADAPTER_ID, HARBOR_RUNTIME_EVIDENCE_PROFILE } from "./runtime/harbor/manifest.js";
export {
  HARBOR_SELECTION_ROLE,
  HARBOR_CORRELATION_ROLE,
  HARBOR_JOB_CONFIG_ROLE,
  HARBOR_JOB_RESULT_ROLE,
  HARBOR_TRIAL_CONFIG_ROLE,
  HARBOR_TRIAL_RESULT_ROLE,
  HARBOR_REWARD_ROLE,
  HARBOR_ATIF_ROLE,
  HARBOR_CTRF_ROLE,
  HARBOR_LOGS_ROLE,
  HARBOR_ARTIFACT_MANIFEST_ROLE,
  HARBOR_COLLECTED_ARTIFACTS_ROLE,
  readHarborDispatchArchive,
  readHarborDispatchArchiveFor,
  harborEvidenceContributionFromArchive,
} from "./runtime/harbor/venue.js";
export { resolveHarborSelection } from "./runtime/harbor/host.js";
export type {
  HarborSelectionManifest,
} from "./runtime/harbor/manifest.js";
export type {
  HarborDispatchArchive,
} from "./runtime/harbor/venue.js";
export type { HarborRuntimeSelectionRequest, HarborRuntimeSelectionResolution } from "./runtime/harbor/host.js";
export {
  TERMINAL_BENCH_2_DATASET_ID,
  TERMINAL_BENCH_2_PROFILE,
  TERMINAL_BENCH_2_SELECTION_ROLE,
  TERMINAL_BENCH_MIGRATION_ROLE,
  HARBOR_021_PACKAGER_ALGORITHM,
  TerminalBench2SelectionManifestSchema,
  TerminalBenchMigrationManifestSchema,
  terminalBench2SelectionBytes,
  terminalBenchMigrationBytes,
} from "./runtime/terminal-bench-2/manifest.js";
export type {
  TerminalBench2SelectionManifest,
  TerminalBenchMaterial,
  TerminalBenchMigrationManifest,
} from "./runtime/terminal-bench-2/manifest.js";
export {
  migrateTerminalBenchLegacyMaterial,
  computeHarbor021TaskContentHash,
  resolveTerminalBench2Selection,
} from "./runtime/terminal-bench-2/host.js";
export { terminalBench2SmokeReadiness } from "./runtime/terminal-bench-2/smoke.js";
export type { TerminalBench2SmokeReadiness, TerminalBench2SmokeReadinessInput } from "./runtime/terminal-bench-2/smoke.js";
export type {
  TerminalBench2SelectionRequest,
  TerminalBench2SelectionResolution,
  TerminalBenchMigrationRequest,
  TerminalBenchMigrationResolution,
} from "./runtime/terminal-bench-2/host.js";

// Demo-1's explicit real-Claude runtime and byte-preserving arm construction. The product does
// not discover executables or source content ambiently; callers bind both before lock.
export {
  DEMO1_CLAUDE_EFFORT,
  DEMO1_CLAUDE_HARNESS_ID,
  DEMO1_CLAUDE_MODEL_ID,
  DEMO1_CLAUDE_MD_PATH,
  DEMO1_EXPERIMENT_PATHS,
  DEMO1_SKILL_PATH,
  createDemo1ClaudeRuntimeBinding,
  demo1ClaudeArmRequirements,
  generateDemo1InstructionArtifacts,
} from "./venue/demo1-claude.js";

// Demo-1 pre-run selection is a fail-closed, product-owned method boundary. It consumes only
// frozen source bytes and outcome-blind task evidence; a STOP inventory is a valid result.
export {
  DEMO1_DOCUMENT_SKILL_PATHS,
  DEMO1_INSTRUCTION_TRANSFORM_ID,
  DEMO1_INSTRUCTION_TRANSFORM_SPEC,
  DEMO1_OUTCOME_BLIND_TASK_CHECKS,
  DEMO1_PRE_E2_OFFICIAL_FEASIBILITY_FLOOR,
  DEMO1_PRE_RUN_FREEZE_SCHEMA,
  DEMO1_SKILLS_SOURCE_URL,
  buildDemo1PreRunFreeze,
  canonicalDemo1PreRunFreezeBytes,
  demo1PreRunFreezeDigest,
  parseDemo1UpstreamSkill,
  verifyDemo1PreRunFreeze,
} from "./method/demo1-prerun.js";

// Demo-1 E4: benchmark-specific preregistration over an injected generic IPFS/ERC-8004 manifest
// boundary. The witness is local handoff evidence, not a new record kind or publication claim.
export {
  DEMO1_PREREGISTRATION_BATCH_KIND,
  DEMO1_PREREGISTRATION_MEDIA_TYPE,
  anchorDemo1Preregistration,
  canonicalDemo1PreregistrationCommitmentBytes,
  canonicalDemo1PreregistrationWitnessBytes,
  verifyDemo1PreregistrationOrdering,
  verifyDemo1PreregistrationPreDispatch,
  verifyDemo1PreregistrationRunOrdering,
} from "./method/demo1-preregistration.js";
export type {
  Demo1OfficialDispatchEvidenceIdentity,
  Demo1PreregistrationAnchorBoundary,
  Demo1PreregistrationCommitment,
  Demo1PreregistrationExternalBlock,
  Demo1PreregistrationOrderingResult,
  Demo1PreregistrationPreDispatchResult,
  Demo1PreregistrationReadBack,
  Demo1PreregistrationRunOrderingResult,
  Demo1PreregistrationWitness,
} from "./method/demo1-preregistration.js";
export { DEMO1_PINNED_SKILLS_SOURCE } from "./method/demo1-prerun-source.js";
export type {
  Demo1AuthenticatedCandidateSource,
  Demo1CandidateInput,
  Demo1CandidateInventory,
  Demo1EvidenceCheck,
  Demo1EvidenceRef,
  Demo1EvidenceStatus,
  Demo1Pool,
  Demo1PreRunFreeze,
  Demo1PreRunFreezeDerived,
  Demo1PreRunFreezeInput,
  Demo1TaskEligibilityInput,
  Demo1TaskInventory,
} from "./method/demo1-prerun.js";

// Demo-1 suitability and E2 sizing are local method artifacts, not new evidence record kinds.
// They schedule only task identities already frozen by the pre-run method and cannot execute
// Docker/model cells or claim power without complete rehearsal observations.
export {
  DEMO1_ARMS,
  DEMO1_DESIGN_ARTIFACT_KIND,
  DEMO1_E2_DECISION_SCHEMA,
  DEMO1_E2_MIN_REPOSITORIES,
  DEMO1_E2_REPLICATES,
  DEMO1_E2_TASKS,
  DEMO1_EQUIVALENCE_MARGIN,
  DEMO1_HAIKU_EFFORT,
  DEMO1_HAIKU_MODEL,
  DEMO1_OFFICIAL_ARMS,
  DEMO1_OFFICIAL_CELL_CEILING,
  DEMO1_POWER_SIMULATIONS,
  DEMO1_REHEARSAL_PLAN_SCHEMA,
  DEMO1_SUITABILITY_REPLICATES,
  DEMO1_SUITABILITY_TASKS,
  DEMO1_TARGET_EFFECT,
  DEMO1_TARGET_POWER,
  assessDemo1HaikuSuitability,
  buildDemo1RehearsalPlan,
  buildDemo1RehearsalPlanFromFreeze,
  canonicalDemo1E2DesignBytes,
  demo1E2DesignDigest,
  demo1RehearsalPlanDigest,
  deriveDemo1E2Design,
  selectDemo1OfficialDesign,
  verifyDemo1E2Design,
  verifyDemo1HaikuSuitabilityAssessment,
  verifyDemo1RehearsalPlan,
} from "./method/demo1-e2-design.js";
export type {
  Demo1DesignTask,
  Demo1E2DesignDecision,
  Demo1E2Estimates,
  Demo1E2RehearsalInput,
  Demo1E2TaskResult,
  Demo1EmptyLoadoutEvidence,
  Demo1HaikuSuitabilityAssessment,
  Demo1PlannedCell,
  Demo1RehearsalPlan,
  Demo1RehearsalPlanInput,
  Demo1SelectedDesign,
  Demo1SimulatedDesignCandidate,
  Demo1SuitabilityAttemptOutcome,
  Demo1SuitabilityCellObservation,
} from "./method/demo1-e2-design.js";
export type {
  Demo1ClaudeArm,
  Demo1ClaudeCommand,
  Demo1ClaudeReadiness,
  Demo1ClaudeRuntimeBinding,
  Demo1ClaudeRuntimeOptions,
  Demo1InstructionArtifacts,
  Demo1SkillFrontmatter,
} from "./venue/demo1-claude.js";

// Workspace metadata and the sealed-bytes store (spec §4.5): exact bytes, digest-addressed.
export { WORKSPACE_STORAGE_VERSION, WorkspaceMetadataSchema } from "./workspace/workspace.js";
export type { WorkspaceMetadata } from "./workspace/workspace.js";
export { getSealedBytes, hasSealedBytes, putSealedBytes, sha256Hex } from "./workspace/sealed-store.js";

// Publication readiness is an explicit projection over durable state/journal capture. It does
// not alter legacy workspaces or synthesize execution history.
export {
  DEFAULT_PUBLICATION_AGENT_KEY_REF,
  DEFAULT_PUBLICATION_SOURCE_NAME,
  PublicationSourceSchema,
  PublicationStageSchema,
  PublicationStateSchema,
  RunStateSchema,
  createPublicationState,
} from "./run/state.js";
export type { PublicationSource, PublicationStage, PublicationState, RunState } from "./run/state.js";
export { assessPublicationCompatibility } from "./run/publication-compatibility.js";
export type { PublicationCompatibilityAssessment } from "./run/publication-compatibility.js";
export { projectPublicationStatus } from "./run/publication-status.js";
export type { PublicationStatusProjection, PublicationStageStatus, PublicationStageName } from "./run/publication-status.js";
export {
  createWorkspacePublicationHttpHandler,
  createWorkspacePublicationSource,
} from "./run/publication-source.js";
export { recordPublicationOrigin } from "./run/publication-authority.js";
export { foldRunJournalLineage } from "./run/journal.js";
export type { DispatchLineageFold } from "./run/journal.js";

// Audit journal read surface (spec §4.4): appends happen only as a side effect of operations.
export { readAuditEntries } from "./audit/journal.js";
export type { AuditEntry } from "./audit/journal.js";

// Principals and authority v1 (spec §4.2): local-process policy enforcement, honestly scoped.
export { GATED_OPERATIONS } from "./authority/policy.js";
export type { AuthorityPolicy, GatedOperation, Principal } from "./authority/policy.js";

// The operations facade (spec §5.1) — the boundary every surface calls.
export {
  armAdd,
  armList,
  armRemove,
  armUpdate,
  authorityGrant,
  authorityRevoke,
  authorityShow,
  createDraft,
  getDraft,
  importSweBenchRows,
  initWorkspace,
  inspectDraft,
  listDrafts,
  publicationAccounting,
  publicationConfigure,
  publicationRegister,
  publicationReport,
  runCancel,
  runCollect,
  runLaunch,
  runLock,
  runPreview,
  runPublish,
  runQuote,
  runReport,
  runResults,
  runResume,
  runStatus,
  runVerify,
  sampleInit,
  selectInspectEvaluation,
  selectHarborRuntime,
  selectTerminalBench2Runtime,
  migrateTerminalBenchLegacyTask,
  updateDraft,
} from "./operations/index.js";
export type {
  ArmAddInput,
  ArmInspection,
  ArmRemoveInput,
  ArmUpdateInput,
  ArmWarning,
  AuthorityGrantInput,
  AuthorityRevokeInput,
  BenchmarkInspection,
  BenchmarkInspectionItem,
  CreateDraftInput,
  DraftInspection,
  DraftSummary,
  ImportSweBenchRowsInput,
  ImportSweBenchRowsResult,
  OperationContext,
  OperationResult,
  MigrateTerminalBenchLegacyTaskInput,
  MigrateTerminalBenchLegacyTaskResult,
  PreviewArtifact,
  PublicationAccountingInput,
  PublicationAccountingResult,
  PublicationConfigureInput,
  PublicationRegisterInput,
  PublicationRegisterDeps,
  PublicationRegistrationResult,
  PublicationReportDeps,
  PublicationReportInput,
  PublicationReportResult,
  QuoteArmSize,
  QuoteCoverageRefusal,
  QuoteEstimatedWallTime,
  QuotePresentation,
  RunCancelDeps,
  RunCancelInput,
  RunCancelResult,
  RunCollectInput,
  RunCollectResult,
  RunLaunchDeps,
  RunLaunchInput,
  RunLaunchResult,
  RunLockInput,
  RunLockResult,
  RunPreviewDeps,
  RunPreviewInput,
  RunPreviewResult,
  RunPublishDeps,
  RunPublishInput,
  RunPublishResult,
  RunQuoteDeps,
  RunQuoteInput,
  RunQuoteResult,
  RunReportInput,
  RunReportResult,
  RunResultsCell,
  RunResultsDocument,
  RunResultsReport,
  RunResultsVerdict,
  RunResumeInput,
  RunResumeResult,
  RunStatusCell,
  SelectTerminalBench2RuntimeInput,
  SelectTerminalBench2RuntimeResult,
  RunStatusCounts,
  RunDriverStatus,
  RunStatusResult,
  RunVerifyCheck,
  RunVerifyInput,
  RunVerifyResult,
  SampleInitInput,
  SampleInitResult,
  SampleInitTaskSummary,
  SelectInspectEvaluationInput,
  SelectInspectEvaluationResult,
  UpdateDraftInput,
  VenueHonesty,
} from "./operations/index.js";
export { LOCAL_VENUE_LIMITS } from "./operations/index.js";

// BP-40: deletion-portable public bundle verification uses only bundle-carried bytes/public keys.
export { verifyPublicBundle } from "./bundle/verify.js";
export type { PublicBundleVerificationCheck, PublicBundleVerificationResult } from "./bundle/verify.js";

// PUB-13b: an additive publication-profile projection. This is intentionally not wired into the
// v2 `publish` operation or CLI: callers opt into its accounting-first, report-optional contract.
export { BUNDLE_V3_FORMAT } from "./bundle/manifest.js";
export { materializeBundleV3 } from "./bundle/v3-materialize.js";
export type {
  BundleV3NativeArtifactInput,
  MaterializeBundleV3Deps,
  MaterializeBundleV3Input,
  MaterializedBundleV3,
} from "./bundle/v3-materialize.js";
export { verifyBundleV3 } from "./bundle/v3-verify.js";
export type { BundleV3VerificationResult, VerifyBundleV3Deps } from "./bundle/v3-verify.js";
export {
  BUNDLE_V3_INDEX_FORMAT,
  BundleV3IndexSchema,
  BundleV3NativeDisclosureSchema,
} from "./bundle/v3-schema.js";
export type { BundleV3Index, BundleV3NativeDisclosure } from "./bundle/v3-schema.js";

// The bundled sample benchmark (BP-11) and SWE-bench row intake, re-exported so a GUI
// client can call them directly without a source dependency on ./intake/*.
export { buildSampleBenchmark, SAMPLE_ISSUER } from "./intake/sample.js";
export type { SampleBenchmark, SampleBenchmarkTask } from "./intake/sample.js";
export { convertSweBenchRows } from "./intake/swebench.js";
export type { ConvertSweBenchRowsOptions } from "./intake/swebench.js";

// The CLI as a library (spec §5.2): `runCli` is a pure function of argv and its context;
// only dist/cli/bin.js touches the process.
export { USAGE, runCli } from "./cli/main.js";
export type { CliContext, CliResult } from "./cli/result.js";

/** The product core's own version, mirrored from package.json. */
export const PRODUCT_VERSION = "0.1.0";
