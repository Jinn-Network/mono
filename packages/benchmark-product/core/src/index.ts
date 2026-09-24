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
export * from "./agent/index.js";
export { BENCHMARKING_PROTOCOL } from "./platform.js";
export { OPERATION_TO_GUI as GUI_CAPABILITY_CATALOG } from "./cli/parity-map.js";
export type { GuiCapability } from "./cli/parity-map.js";
export * from "./evidence-first.js";
export {
  buildBinaryJudgmentAdmissionClosureWorkspacePorts,
  verifyBinaryJudgmentAdmissionClosureInWorkspace,
} from "./run/admission-workspace.js";
export type { VerifyBinaryJudgmentAdmissionClosureInWorkspaceInput } from "./run/admission-workspace.js";

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
export { assessAgentRuntimeReadiness } from "./runtime/agent-readiness.js";
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
  assertHarborRetryPinnedOff,
  assertHarborRetriesAccounted,
  assertHarborTrialMatchesCell,
  harborSelectedTaskNames,
  harborTrialAttemptNumber,
  harborTrialTaskName,
} from "./runtime/harbor/manifest.js";
export { HARBOR_ADAPTER_ID, PIER_ADAPTER_ID, HARBOR_RUNTIME_EVIDENCE_PROFILE } from "./runtime/harbor/manifest.js";
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
export { harborImagePinMatchesTaskToml, resolveHarborSelection } from "./runtime/harbor/host.js";
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
export { terminalBench2ExternalReadiness } from "./runtime/terminal-bench-2/external-readiness.js";
export type { TerminalBench2ExternalReadiness, TerminalBench2ExternalReadinessInput } from "./runtime/terminal-bench-2/external-readiness.js";
export type {
  TerminalBench2SelectionRequest,
  TerminalBench2SelectionResolution,
  TerminalBenchMigrationRequest,
  TerminalBenchMigrationResolution,
} from "./runtime/terminal-bench-2/host.js";
export {
  TERMINAL_BENCH_2_1_DATASET_ID,
  TERMINAL_BENCH_2_1_DATASET_REF,
  TERMINAL_BENCH_2_1_PROFILE,
  TERMINAL_BENCH_2_1_SELECTION_ROLE,
  TerminalBench21SelectionManifestSchema,
  terminalBench21SelectionBytes,
} from "./runtime/terminal-bench-2-1/manifest.js";
export type { TerminalBench21SelectionManifest } from "./runtime/terminal-bench-2-1/manifest.js";
export { resolveTerminalBench21Selection } from "./runtime/terminal-bench-2-1/host.js";
export {
  SWE_BENCH_VERIFIED_DATASET_ID,
  SWE_BENCH_VERIFIED_DATASET_REVISION,
  SWE_BENCH_HARNESS_ADAPTER_ID,
  SWE_BENCH_VERIFIED_DEFAULT_TIMEOUT_SECONDS,
  SwebenchVerifiedSelectionManifestSchema,
  swebenchVerifiedSelectionBytes,
} from "./runtime/swe-bench-verified/manifest.js";
export type { SwebenchVerifiedSelectionManifest } from "./runtime/swe-bench-verified/manifest.js";
export { resolveSwebenchVerifiedSelection } from "./runtime/swe-bench-verified/host.js";
export type {
  SwebenchVerifiedSelectionRequest,
  SwebenchVerifiedSelectionResolution,
} from "./runtime/swe-bench-verified/host.js";
export {
  launchSwebenchHarness,
  writePredictionsJsonl,
  swebenchRunId,
  resolveSwebenchHarnessRunId,
  swebenchModelNameOrPath,
  collectSwebenchHarnessCells,
} from "./runtime/swe-bench-verified/launcher.js";
export { harnessReportsPresent, harnessReportPath, readHarnessReport } from "./runtime/swe-bench-verified/reports.js";
export {
  APEX_AGENTS_DATASET_ID,
  APEX_AGENTS_DATASET_REVISION,
  ARCHIPELAGO_ADAPTER_ID,
  ARCHIPELAGO_COMMIT_PIN,
  APEX_AGENTS_DEFAULT_MAX_STEPS,
  APEX_AGENTS_DEFAULT_TIMEOUT_SECONDS,
  ApexAgentsSelectionManifestSchema,
  apexAgentsSelectionBytes,
} from "./runtime/apex-agents/manifest.js";
export type { ApexAgentsSelectionManifest } from "./runtime/apex-agents/manifest.js";
export { resolveApexAgentsSelection } from "./runtime/apex-agents/host.js";
export type {
  ApexAgentsSelectionRequest,
  ApexAgentsSelectionResolution,
} from "./runtime/apex-agents/host.js";
export {
  launchArchipelago,
  resolveArchipelagoRunId,
  archipelagoRunId,
  archipelagoModelId,
  collectArchipelagoCells,
} from "./runtime/apex-agents/launcher.js";
export { archipelagoGradesPresent, archipelagoGradePath, readArchipelagoGrade } from "./runtime/apex-agents/grades.js";
export type {
  TerminalBench21SelectionRequest,
  TerminalBench21SelectionResolution,
} from "./runtime/terminal-bench-2-1/host.js";
export {
  TERMINAL_BENCH_3_0_DATASET_ID,
  TERMINAL_BENCH_3_0_DATASET_REF,
  TERMINAL_BENCH_3_0_HUB_VERSION,
  TERMINAL_BENCH_3_0_PROFILE,
  TERMINAL_BENCH_3_0_SELECTION_ROLE,
  TerminalBench30SelectionManifestSchema,
  terminalBench30SelectionBytes,
} from "./runtime/terminal-bench-3-0/manifest.js";
export type { TerminalBench30SelectionManifest } from "./runtime/terminal-bench-3-0/manifest.js";
export { resolveTerminalBench30Selection } from "./runtime/terminal-bench-3-0/host.js";
export type {
  TerminalBench30SelectionRequest,
  TerminalBench30SelectionResolution,
} from "./runtime/terminal-bench-3-0/host.js";
export {
  APEX_SWE_DEV_ADAPTER_ID,
  APEX_SWE_DEV_DATASET_ID,
  APEX_SWE_DEV_DATASET_REVISION,
  APEX_SWE_DEV_DATASET_TASK_COUNT,
  APEX_SWE_HARNESS_REVISION,
  APEX_SWE_DEV_SELECTION_ROLE,
  ApexSweDevSelectionManifestSchema,
  apexSweDevSelectionBytes,
} from "./runtime/apex-swe-dev/manifest.js";
export type { ApexSweDevSelectionManifest } from "./runtime/apex-swe-dev/manifest.js";
export { resolveApexSweDevSelection, isGitLfsPointerBytes, readApexSweDevHostBinding } from "./runtime/apex-swe-dev/host.js";
export type {
  ApexSweDevSelectionRequest,
  ApexSweDevSelectionResolution,
} from "./runtime/apex-swe-dev/host.js";
export { launchApexSweDev, collectApexSweDevCells, apexSweDevReportRoot } from "./runtime/apex-swe-dev/launcher.js";
export {
  harnessReportsPresent as apexSweDevHarnessReportsPresent,
  harnessReportPath as apexSweDevHarnessReportPath,
  readHarnessReport as readApexSweDevHarnessReport,
} from "./runtime/apex-swe-dev/reports.js";
export {
  COMMUNITY_SUBMISSIONS_CLOSED_SENTENCE,
  APEX_SWE_DEV_NOT_LEADERBOARD_READY_LIMITATION,
  APEX_SWE_DEV_SUBMIT_CLOSED_SENTENCE,
  SUITE_NOT_LEADERBOARD_READY_LIMITATION,
  SUITE_NOT_LEADERBOARD_READY_LIMITATION_3_0,
  deriveSuiteComparability,
  methodLeaderboardEligible,
  officialHarborExecutionConformance,
  officialSwebenchHarnessConformance,
  SWE_BENCH_VERIFIED_NOT_LEADERBOARD_READY_LIMITATION,
  SWE_BENCH_VERIFIED_SUBMIT_CLOSED_SENTENCE,
  APEX_AGENTS_NOT_LEADERBOARD_READY_LIMITATION,
  APEX_AGENTS_SUBMIT_CLOSED_SENTENCE,
  officialArchipelagoConformance,
  officialApexSweDevConformance,
  suiteLeaderboardLimitation,
} from "./runtime/suite-protocol/comparability.js";
export type { SuiteComparability, SuiteCoverage, SuiteProtocolId } from "./runtime/suite-protocol/comparability.js";
export {
  SUITE_PROTOCOL_PROFILE,
  SUITE_PROTOCOL_SELECTION_ROLE,
  coverageFromSelectedNames,
  namedSliceTaskNames,
} from "./runtime/suite-protocol/manifest.js";
export type {
  AgentRuntimeReadiness,
  AgentRuntimeReadinessCode,
  AgentRuntimeReadinessRequest,
} from "./runtime/agent-readiness.js";
export type {
  InspectRuntimeMethodDisclosure,
  InspectScoringProjectionDisclosure,
} from "./runtime/inspect/disclosure.js";
export type { InspectScoringRequest, InspectScoreProjection } from "./runtime/inspect/manifest.js";
export {
  INSPECT_BINARY_JUDGE_ADAPTER_ID,
  INSPECT_BINARY_JUDGE_LAUNCHER_ID,
  INSPECT_BINARY_JUDGE_LAUNCHER_VERSION,
  INSPECT_BINARY_JUDGE_SELECTION_SCHEMA,
  InspectBinaryJudgeBindingRequestSchema,
  InspectBinaryJudgeHostBindingSchema,
  InspectBinaryJudgeSelectionManifestSchema,
} from "./runtime/inspect/binary-judge-manifest.js";
export type {
  InspectBinaryJudgeArm,
  InspectBinaryJudgeBindingRequest,
  InspectBinaryJudgeHostBinding,
  InspectBinaryJudgeSelectionManifest,
} from "./runtime/inspect/binary-judge-manifest.js";
export {
  INSPECT_BINARY_JUDGE_CONFIG_FILENAME,
  INSPECT_BINARY_JUDGE_OCI_CONFIG_PATH,
  INSPECT_BINARY_JUDGE_OCI_OUTPUT_DIR,
  INSPECT_BINARY_JUDGE_OUTPUT_FILES,
  buildInspectBinaryJudgeOciRunArgs,
  buildInspectBinaryJudgeWorkerInput,
  inspectBinaryJudgeWorkerPath,
  inspectBinaryJudgeWorkerSha256,
  makeInspectBinaryJudgeLauncher,
  validateInspectBinaryJudgePinning,
} from "./runtime/inspect/binary-judge.js";
export type { InspectBinaryJudgeWorkerInput } from "./runtime/inspect/binary-judge.js";

export {
  NATIVE_SNAPSHOT_ALGORITHM,
  NativeSnapshotRefusedError,
  NativeSourceMutatedError,
  STRICT_SNAPSHOT_POLICY,
  createFilesystemNativeSnapshotPort,
  createProcessNativeLauncher,
} from "./runtime/native-ports.js";
export type {
  FilesystemSnapshotOptions,
  ProcessLauncherOptions,
} from "./runtime/native-ports.js";

// Workspace metadata and the sealed-bytes store (spec §4.5): exact bytes, digest-addressed.
export { WORKSPACE_STORAGE_VERSION, WorkspaceAnchoringEntrySchema, WorkspaceMetadataSchema, DEFAULT_ENTRY_ANCHOR_SKEW_ALLOWANCE_MS, entryAnchorSkewAllowanceMs } from "./workspace/workspace.js";
export type { WorkspaceAnchoringEntry, WorkspaceMetadata } from "./workspace/workspace.js";
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
  normalizePublicArchiveBaseUrl,
  publicArchiveUrl,
  refreshWorkspacePublicationWellKnown,
  resolveWorkspacePublicationSourceName,
} from "./run/publication-source.js";
export {
  DEFAULT_PUBLICATION_SERVE_HOST,
  DEFAULT_PUBLICATION_SERVE_PORT,
  startPublicationArchiveServer,
} from "./run/publication-serve.js";
export type {
  PublicationArchiveServer,
  PublicationArchiveServerOptions,
  PublicationWellKnownOutcome,
} from "./run/publication-serve.js";
export {
  expectedIntervalWidth,
  formatSampleSizeAdvisory,
  sampleSizeAdvisory,
} from "./run/sample-size-advisory.js";
export type { DeclaredAnalysis, SampleSizeAdvisory, SampleSizeWidth } from "./run/sample-size-advisory.js";
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
  importRunRecords,
  inspectDraft,
  listDrafts,
  publicationAccounting,
  publicationConfigure,
  publicationRegister,
  publicationReport,
  publicationStatus,
  runCancel,
  runCollect,
  runLaunch,
  runLock,
  draftSampleSizeAdvisory,
  runAnchor,
  runBind,
  anchoringConfigure,
  identityBind,
  disclosureDeclare,
  disclosureShow,
  runPreview,
  runPublish,
  runQuote,
  runReport,
  runResults,
  runResume,
  runStatus,
  runVerify,
  sampleInit,
  selectMethod,
  exportDerivedBundle,
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
  RunImportInput,
  RunImportResult,
  RunLaunchDeps,
  RunLaunchInput,
  RunLaunchResult,
  RunLockInput,
  RunAnchorInput,
  RunAnchorResult,
  RunBindInput,
  RunBindResult,
  AnchorSubject,
  AnchoringConfigureInput,
  AnchoringConfigureResult,
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
  SelectMethodInput,
  SelectMethodResult,
  ExportDerivedBundleInput,
  ExportDerivedBundleResult,
  RunStatusCounts,
  RunDriverStatus,
  RunStatusResult,
  RunVerifyCheck,
  RunVerifyInput,
  RunVerifyResult,
  SampleInitInput,
  SampleInitResult,
  SampleInitTaskSummary,
  UpdateDraftInput,
  VenueHonesty,
} from "./operations/index.js";
export { LOCAL_VENUE_LIMITS } from "./operations/index.js";

// The `lock` verb's own anchor hook (anchor-evidence design §7.2), exported from its module rather
// than through the operations facade — deliberately, and permanently. The facade's inventory is
// exactly the operations, which is the invariant `./cli/parity-map.ts` and `./cli/parity.test.ts`
// depend on; this is a surface helper, like the workspace and journal readers above it. Both
// shipped surfaces call it after a successful lock so neither can drift into a lock that quietly
// skips the errand the other performs. It never throws: every anchor outcome is typed, and the
// operation audits itself.
export { anchorAfterLockIfConfigured } from "./operations/run-anchor.js";
export type { AnchorAfterLockOutcome } from "./operations/run-anchor.js";

// Method catalog listing is CLI/GUI discovery, not a facade operation (DR-2026-08-19; parity stays 41).
export { METHOD_CATALOG, isMethodCatalogId, listMethodCatalog } from "./operations/method-catalog.js";


// BP-40: deletion-portable public bundle verification uses only bundle-carried bytes/public keys.
export { verifyPublicBundle } from "./bundle/verify.js";
// The one derivation of what a verification result may be said to have proved. Re-exported beside
// `verifyPublicBundle` so every consumer of that result reaches the same counts and check states
// rather than counting `checks` for itself (issue #2986).
// `bundleIdentityLabel` rides beside it for the same reason: the identity a reader quotes is
// normalized once, so a surface cannot render `sha256:sha256:...` for the format whose identity
// already carries the prefix (issue #3312).
export { bundleIdentityLabel, summarizeVerificationOutcome } from "@colophon-claims/check";
export type {
  VerificationCheckOutcome,
  VerificationCheckState,
  VerificationOutcome,
} from "@colophon-claims/check";
export type { PublicBundleVerificationCheck, PublicBundleVerificationResult } from "./bundle/verify.js";

// The `beacon-binding/1` surface a caller needs to OFFER a binding (issue #2976): the admitted
// beacon sources and the reference shape. Re-exported through this facade for the same reason the
// verification-outcome summary is — the product's GUI may import only this package, and a second
// copy of the source registry would be a second place the admitted beacons could drift.
export { BEACON_SOURCES, BEACON_SOURCE_IDS, MAX_BEACON_ROUND } from "@colophon-claims/check";
export type { BeaconReference, BeaconSourceId, RunBindingClass, VerifiedRunBinding } from "@colophon-claims/check";

// The declared denominator beside the strict all-slots one (issue #2977). Re-exported for the same
// reason as the two surfaces above: the product's GUI imports only this package, and a second copy
// of the derivation would be a second place the two numbers could disagree.
export { armDenominators } from "@colophon-claims/check";
export type { ArmDenominators, PlannedSlotAccounting } from "@colophon-claims/check";

// PUB-13b: an additive publication-profile projection. This is intentionally not wired into the
// v2 `publish` operation or CLI: callers opt into its accounting-first, report-optional contract.
export { BUNDLE_V3_FORMAT } from "./bundle/manifest.js";

// The bundled sample benchmark (BP-11) and SWE-bench row intake, re-exported so a GUI
// client can call them directly without a source dependency on ./intake/*.
export { buildSampleBenchmark, SAMPLE_ISSUER } from "./intake/sample.js";
export type { SampleBenchmark, SampleBenchmarkTask } from "./intake/sample.js";
export { convertSweBenchRows } from "./intake/swebench.js";
export type { ConvertSweBenchRowsOptions } from "./intake/swebench.js";
export {
  BINARY_ITEM_BANK_INTAKE_EXTENSION,
  parseBinaryItemBankIntakeExtension,
} from "./run/binary-instrument-profile.js";
export {
  BINARY_ADMISSION_INDEX_ENTRY_PROTOCOL,
  BINARY_ITEM_BANK_ENTRY_PROTOCOL,
  BINARY_SOURCE_MANIFEST_ENTRY_PROTOCOL,
  BinaryAdmissionIndexEntrySchema,
  BinaryItemBankEntrySchema,
  BinaryItemBankIntakeExtensionSchema,
  BinarySourceManifestEntrySchema,
} from "@colophon-claims/check/admission";
export type {
  BinaryAdmissionIndexEntry,
  BinaryItemBankEntry,
  BinaryItemBankIntakeExtension,
  BinarySourceManifestEntry,
} from "@colophon-claims/check/admission";

// The CLI as a library (spec §5.2): `runCli` is a pure function of argv and its context;
// only dist/cli/bin.js touches the process.
export { USAGE, runCli } from "./cli/main.js";
export type { CliContext, CliResult } from "./cli/result.js";

/** The product core's own version, mirrored from package.json. */
export const PRODUCT_VERSION = "0.1.0";
// Reader-legible publisher identity (issue #2983).
export type { IdentityBindInput, IdentityBindResult } from "./operations/index.js";
