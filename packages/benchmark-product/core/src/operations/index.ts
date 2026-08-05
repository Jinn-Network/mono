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
