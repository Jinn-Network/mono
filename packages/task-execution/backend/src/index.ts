// @jinn-network/task-execution-backend — the frozen backend contract (§14/§15/§22).
// Depends on @jinn-network/task-execution-protocol only.

export {
  RUN_PINNING_ENFORCEMENT_POSTURES,
} from "./capabilities.js";
export type {
  BackendCapabilities,
  RunPinningEnforcementPosture,
  RunPinningKeySupport,
} from "./capabilities.js";

export type {
  AttemptUri,
  CancelAck,
  DeliveryRef,
  ObservationCursor,
  ObservationSnapshot,
  PreflightReport,
  PreflightRequest,
  ReconciliationReport,
  SubmissionAck,
  SubmissionUri,
  TwoPartyEngagement,
} from "./types.js";

export { TaskExecutionError } from "./errors.js";

export type { TaskExecutionBackend } from "./backend.js";

export {
  validateRequirementsAgainstRunPinning,
  verifyPreclaim,
} from "./preclaim.js";
export type {
  BackendPreclaimRequest,
  PreclaimNotClaimedReason,
  PreclaimResult,
} from "./preclaim.js";
