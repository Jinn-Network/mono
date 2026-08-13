/**
 * The operations library's public facade (spec §5.1): the single trusted
 * boundary every surface — CLI, GUI — consumes. All validation, authority
 * checks, lifecycle transitions, and audit-journal appends live behind this
 * facade, never in a surface.
 *
 * Later packets extend this facade by ADDING operation modules (new files
 * alongside these) and re-exporting them here — extensions are new files,
 * never rewrites of the modules already shipped (spec §5.1).
 *
 * `operate` itself is not re-exported: it is the internal boundary helper
 * this facade's own operations run through, not a surface a caller invokes
 * directly (see operate.ts).
 */

export type { OperationContext } from "./context.js";
export type { OperationResult } from "./result.js";

export { initWorkspace } from "./init.js";

export {
  createDraft,
  getDraft,
  listDrafts,
  updateDraft,
  type CreateDraftInput,
  type DraftSummary,
  type UpdateDraftInput,
} from "./drafts.js";

export {
  inspectDraft,
  type ArmInspection,
  type BenchmarkInspection,
  type BenchmarkInspectionItem,
  type DraftInspection,
} from "./inspect.js";

export { sampleInit, type SampleInitInput, type SampleInitResult, type SampleInitTaskSummary } from "./sample.js";

export { importSweBenchRows, type ImportSweBenchRowsInput, type ImportSweBenchRowsResult } from "./import.js";

export {
  selectInspectEvaluation,
  type SelectInspectEvaluationInput,
  type SelectInspectEvaluationResult,
} from "./inspect-runtime.js";

export {
  armAdd,
  armList,
  armRemove,
  armUpdate,
  type ArmAddInput,
  type ArmRemoveInput,
  type ArmUpdateInput,
  type ArmWarning,
} from "./arms.js";

export {
  authorityGrant,
  authorityRevoke,
  authorityShow,
  type AuthorityGrantInput,
  type AuthorityRevokeInput,
} from "./authority-ops.js";

// BP-12: run wiring (spec §4.1 quoted through closed) — quote, lock, launch/resume, status,
// collect, results. `run-*.ts` sibling modules, extending the facade per this file's own header.
export {
  runQuote,
  type RunQuoteDeps,
  type RunQuoteInput,
  type RunQuoteResult,
  // BP-20 (spec §4.6 Quote row): the presentation types `runQuote`'s result carries.
  type QuoteArmSize,
  type QuoteCoverageRefusal,
  type QuoteEstimatedWallTime,
  type QuotePresentation,
} from "./run-quote.js";
export { runLock, type RunLockInput, type RunLockResult } from "./run-lock.js";
export {
  publicationConfigure,
  publicationRegister,
  type PublicationConfigureInput,
  type PublicationRegisterInput,
  type PublicationRegistrationResult,
} from "./publication-register.js";
export {
  runLaunch,
  runResume,
  type RunLaunchDeps,
  type RunLaunchInput,
  type RunLaunchResult,
  type RunResumeInput,
  type RunResumeResult,
} from "./run-launch.js";
export { runStatus, type RunDriverStatus, type RunStatusCell, type RunStatusCounts, type RunStatusResult } from "./run-status.js";
export { runCollect, type RunCollectInput, type RunCollectResult } from "./run-collect.js";
export {
  runResults,
  LOCAL_VENUE_LIMITS,
  unverifiableAxisCounts,
  type RunResultsCell,
  type RunResultsDocument,
  type RunResultsReport,
  type RunResultsVerdict,
  type VenueHonesty,
} from "./run-results.js";

// BP-13: report production + verification (spec §7.1/§8.2/§12.1) — `report` seals the Report
// record and the claim package from a closed run's sealed Matrix; `verify` independently
// re-derives the Matrix (and, once reported, the Report and claim package) from the workspace's
// own durable state.
export { runReport, type RunReportInput, type RunReportResult } from "./report.js";
export { runVerify, type RunVerifyCheck, type RunVerifyInput, type RunVerifyResult } from "./verify.js";
export { runPublish, type RunPublishDeps, type RunPublishInput, type RunPublishResult } from "./publish.js";

// BP-20: disposable previews (spec §7.2) — `preview` rehearses a draft's solve cells against an
// ephemeral subset benchmark and a disposable scratch venue; it never enters official state.
// Ungated (any workspace member may preview) and non-advancing (draft/quoted lifecycle state is
// unchanged either way, spec §4.1 assumption A5).
export { runPreview, type PreviewArtifact, type RunPreviewDeps, type RunPreviewInput, type RunPreviewResult } from "./preview.js";

// BP-22: cancellation (spec §4.1 running --cancel--> closed, GATED) — `cancel` stops dispatch,
// drains outstanding cells to a boundary, and seals the Matrix with the cancellation accounted.
export { runCancel, type RunCancelDeps, type RunCancelInput, type RunCancelResult } from "./run-cancel.js";
