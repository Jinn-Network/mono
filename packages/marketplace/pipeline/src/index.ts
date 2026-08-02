// SPDX-License-Identifier: MIT

// @jinn-network/marketplace-pipeline — operator claim predicate, execution wiring, caps, two-party
// engagement composition, and the §9 TaskEngine carve disposition (design §7/§9; plan M6).

export {
  CLAIM_NOTHING,
  evaluateClaimPredicate,
  matchLegacyManifestDigest,
  takeEveryRunnable,
} from "./claim-predicate.js";
export type { ClaimPredicate } from "./claim-predicate.js";

export { checkCaps } from "./caps.js";

export {
  resolveWiringEntry,
  runPinningConstraint,
  wiringHonorsPinning,
} from "./execution-wiring.js";

export { buildEngagement } from "./engage.js";
export type { EngagementClaim } from "./engage.js";

export {
  carveOwnerForFailed,
  TASK_ENGINE_CARVE,
  TASK_ENGINE_FAILED_CARVE,
} from "./carve.js";
export type { TaskEngineCarveState } from "./carve.js";

export {
  runPipeline,
} from "./pipeline.js";
export type {
  DeliveryWaitPort,
  DeliveryWaitResult,
  FinalityPort,
  FinalityAwaitResult,
  PipelineConfig,
  PipelinePorts,
  PipelineRunInput,
  PipelineRunOutcome,
  ReleaseAttemptPort,
} from "./pipeline.js";

export type {
  CarveOwner,
  ExecutionWiringEntry,
  OperatorCaps,
  SubmissionFacts,
  TaskEngineFailedCause,
} from "./types.js";

export { mapAnnouncedSubmissionToFacts } from "./facts-mapper.js";
export { RECORD_KINDS_SUBMISSION } from "./facts-mapper-kinds.js";
export {
  validateRequirementsAgainstRunPinning,
  verifyPreclaim,
} from "./preclaim.js";
export type { PreclaimNotClaimedReason, PreclaimResult } from "./preclaim.js";
export type {
  AnnouncedSubmissionCard,
  FactsMapperOptions,
  FactsMappingRefusal,
  FactsMappingResult,
} from "./facts-mapper.js";
