/**
 * The product core's public surface.
 *
 * The operations facade is the single trusted boundary (spec §5.1): all validation,
 * authority checks, lifecycle transitions, and audit-journal appends live behind it,
 * and every surface — the CLI here, the GUI in a later milestone — is a client of it.
 * The domain vocabulary (draft schemas, lifecycle machine, typed errors) is exported
 * so clients can render and reason about product state without re-deriving it.
 */

export type { ProductBranding } from "./branding.js";
export { PRODUCT_BRANDING } from "./branding.js";
export { BENCHMARKING_PROTOCOL } from "./platform.js";

// Typed errors (spec §4.3): callers branch on `code`, never on `message`.
export { BenchmarkProductError, toErrorEnvelope } from "./errors.js";
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
  ResolvedAssurance,
} from "./domain/draft.js";

// Workspace metadata and the sealed-bytes store (spec §4.5): exact bytes, digest-addressed.
export { WORKSPACE_STORAGE_VERSION, WorkspaceMetadataSchema } from "./workspace/workspace.js";
export type { WorkspaceMetadata } from "./workspace/workspace.js";
export { getSealedBytes, hasSealedBytes, putSealedBytes, sha256Hex } from "./workspace/sealed-store.js";

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
  runCollect,
  runLaunch,
  runLock,
  runQuote,
  runResults,
  runResume,
  runStatus,
  sampleInit,
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
  RunCollectInput,
  RunCollectResult,
  RunLaunchDeps,
  RunLaunchInput,
  RunLaunchResult,
  RunLockInput,
  RunLockResult,
  RunQuoteDeps,
  RunQuoteInput,
  RunQuoteResult,
  RunResultsCell,
  RunResultsDocument,
  RunResultsVerdict,
  RunResumeInput,
  RunResumeResult,
  RunStatusCell,
  RunStatusCounts,
  RunStatusResult,
  SampleInitInput,
  SampleInitResult,
  SampleInitTaskSummary,
  UpdateDraftInput,
  VenueHonesty,
} from "./operations/index.js";

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
