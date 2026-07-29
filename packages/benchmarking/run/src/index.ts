// @jinn-network/benchmarking-run — backend-neutral run orchestrator (design §7.3–.4, §8, §10.1).
// Consumes TaskExecutionBackend + venue inputs only through contracts / injected ports.
// Never imports a concrete backend, evidence binding, marketplace package, or aggregate.

export type {
  AdmissionEvidencePort,
  AssemblyPorts,
  AssemblyProcedure,
  CellCost,
  CloseBoundary,
  CloseBoundaryResolver,
  CostSource,
  InScopeCell,
  InScopeVerdict,
  InputScope,
  IntegrityTier,
  MatrixSignaturePort,
  PinningAxisStatus,
  PinningObservation,
  PinningObservationPort,
  TrustResolver,
} from "./ports.js";

export { planRun } from "./plan.js";
export type { BenchmarkPlanInput, PlannedRun } from "./plan.js";

export { quoteRun } from "./quote.js";
export type { QuoteError, QuoteErrorCode, QuoteReport } from "./quote.js";

export {
  computeCellDeadline,
  defaultClassifyTerminal,
  launchAndWatch,
  resumeRun,
  CellCorrespondenceError,
} from "./launch.js";
export type {
  AcceptedSubmissionPort,
  AttemptWaitPort,
  CellStatusEvent,
  CellStatusKind,
  Clock,
  HostTerminalFacts,
  LaunchOptions,
  ReplaceableReason,
  TerminalClassifier,
} from "./launch.js";

export {
  assertCellCorrespondence,
  cellCorrespondenceHolds,
  checkEvaluatorIndependence,
  checkPinningObservation,
  checkPreregistrationAnchoredOrder,
  checkPreregistrationPrecedesDispatchLegA,
  checkPreregistrationPrecedesDispatchLegC,
  checkVerdictRuleConsistency,
  checkVerdictSpecMatch,
} from "./checks.js";

export { summarizeCellStatus } from "./status.js";
export type { CellStatusSummary } from "./status.js";

export { assembleMatrix, deriveOutcome, deriveParticipantExclusion } from "./assemble.js";
export type { AssembledMatrix } from "./assemble.js";

export { verifyMatrix } from "./verify.js";
export type { VerifyMatrixResult } from "./verify.js";
