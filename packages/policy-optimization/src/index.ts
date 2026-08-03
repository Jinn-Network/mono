// SPDX-License-Identifier: MIT

/**
 * `@jinn-network/policy-optimization` — public surface.
 *
 * The Policy Optimization product (tier 4). Two sub-units are here:
 *
 * - **C7a, the core state layer** — the sealed campaign document and its append-only lifecycle
 *   journal.
 * - **C7b, the wave engine** — planning, executing, assembling, and reporting on waves, plus the
 *   dev-wave allocator and the single promotion Run. It **composes** `benchmarking-run`,
 *   `benchmarking-local`, and `benchmarking-aggregate`; it implements no execution, assembly, or
 *   aggregation machinery of its own, and no statistic (program ruling R3).
 *
 * Admission and proposers (C7c) and the archive and CLI (C7d) build on exactly these types.
 *
 * Authority: `docs/superpowers/specs/2026-08-03-policy-optimization-product-design.md` §5–§6.3.
 */

export * from "./tokens.js";
export type {
  CampaignAllocation,
  CampaignBudgets,
  CampaignDocument,
  CampaignObjective,
  CampaignStoppingRule,
  CampaignTarget,
  ExecutionPolicyTuple,
  JsonValue,
  ObjectiveConstraint,
  ObjectiveMethodRef,
  PolicyRef,
  SealedCampaign,
  SeedResolution,
} from "./types.js";

export {
  PolicyOptimizationError,
  type PolicyOptimizationErrorCategory,
  type PolicyOptimizationIssue,
  type ValidationResult,
} from "./errors.js";

// --- product §5.1: the campaign document ---
export {
  checkSeedAgreement,
  isNamespacedExtensionKey,
  parseExactCampaign,
  sealCampaign,
  validateCampaign,
} from "./campaign.js";
export { assertExactPin, axisValuesByteShare, isExactPin } from "./frozen-axes.js";

// --- product §6.3: the committed-and-unrevealed promotion gate ---
export {
  checkExploringEntry,
  type ExploringEntryAdmission,
  type ExploringEntryInput,
  type ExploringEntryRefusal,
  type ExploringEntryResult,
} from "./exploring-entry.js";

// --- product §5.2: the append-only journal ---
export {
  buildJournalEntry,
  journalEntryDigest,
  journalEntryText,
  parseExactJournalLine,
  validateJournalEntry,
  type CampaignJournalEntry,
  type CampaignJournalEntryInput,
  type CampaignJournalEventType,
} from "./journal-entry.js";
export {
  checkEventLegality,
  entersExploring,
  legalEventsIn,
  type CampaignLifecyclePhase,
  type CampaignLifecycleState,
} from "./journal-lifecycle.js";
export {
  appendCampaignEvent,
  createCampaign,
  openCampaign,
  type AppendOptions,
  type CampaignHandle,
  type CreateCampaignInput,
} from "./journal-store.js";

// --- product §6.1: arms, from admitted candidates ---
export {
  assertArmsAgreeOnFrozenAxes,
  buildWaveArms,
  checkCandidateAgainstCampaign,
} from "./arms.js";

// --- product §6.2: the dev-wave allocator (pure) ---
export {
  ALLOCATION_POLICY_REFS,
  compareExactDecimals,
  compareObservedRates,
  decideAllocation,
  type AllocationInput,
  type AllocationPolicyRef,
} from "./allocation.js";

// --- product §6.1: wave planning ---
export {
  STOPPING_RULE_REFS,
  checkStoppingRule,
  committedCells,
  deriveWaveBenchmark,
  planWave,
  type DerivedWaveBenchmark,
  type PlanWaveInput,
  type StoppingRuleResult,
} from "./wave.js";

// --- product §6.1: execution and assembly ---
export {
  assembleWaveMatrix,
  executeWave,
  type AssembleWaveInput,
  type ExecuteWaveInput,
  type WaveLaunchOptions,
} from "./execute.js";

// --- product §6.1/§6.3: Reports, through the method registry only (ruling R3) ---
export {
  objectiveMethod,
  produceWaveReport,
  type WaveReportInput,
  type WaveVerdictRule,
} from "./wave-report.js";

// --- product §6.3: the single promotion Run ---
export {
  checkPromotionReveal,
  objectiveAnalysisPlan,
  planPromotionRun,
  type PlanPromotionRunInput,
  type PlannedPromotion,
  type PromotionAdmission,
  type PromotionReveal,
} from "./promotion.js";

// --- product §5.2/§6.2: the wave engine's journal payloads ---
export {
  allocationDecidedPayload,
  appendWaveEvent,
  matrixAssembledPayload,
  promotionRunSealedPayload,
  reportRecordedPayload,
  runSealedPayload,
  wavePlannedPayload,
} from "./wave-journal.js";

export type {
  AdmittedCandidate,
  AllocationDecision,
  AllocationInputRefs,
  CommittedCells,
  DroppedTask,
  OutcomesProjectionRow,
  PrunedCandidate,
  RateBound,
  TaskInformativenessRow,
  WaveArm,
  WaveAssemblyVenue,
  WaveCellEvidence,
  WaveCellEvidencePort,
  WaveDispatch,
  WaveExecution,
  WavePlan,
  WaveReportRow,
  WaveRunSettings,
} from "./wave-types.js";
export { NO_CELLS_COMMITTED } from "./wave-types.js";
