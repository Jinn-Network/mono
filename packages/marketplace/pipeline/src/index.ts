// SPDX-License-Identifier: MIT

// @jinn-network/marketplace-pipeline — frozen legacy operator compatibility surface. New product
// code composes task-execution and marketplace-binding capabilities directly.

/** @deprecated Legacy operator compatibility; no new consumers. */
export {
  CLAIM_NOTHING,
  evaluateClaimPredicate,
  matchLegacyManifestDigest,
  takeEveryRunnable,
} from "./claim-predicate.js";
/** @deprecated Legacy operator compatibility type. */
export type { ClaimPredicate } from "./claim-predicate.js";

/** @deprecated Legacy operator compatibility; product caps belong in tier-4 policy. */
export { checkCaps } from "./caps.js";

/** @deprecated Legacy operator compatibility; execution wiring belongs in tier-4 policy. */
export {
  resolveWiringEntry,
  runPinningConstraint,
  wiringHonorsPinning,
} from "./execution-wiring.js";

/** @deprecated Legacy operator compatibility; scheduled for deletion with the legacy loop. */
export { buildEngagement } from "./engage.js";
/** @deprecated Legacy operator compatibility type. */
export type { EngagementClaim } from "./engage.js";

/** @deprecated Legacy operator compatibility; native mode never enters this pipeline. */
export {
  runPipeline,
} from "./pipeline.js";
/** @deprecated Legacy operator compatibility types. */
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

/** @deprecated Legacy operator compatibility types. */
export type {
  ExecutionWiringEntry,
  OperatorCaps,
  SubmissionFacts,
} from "./types.js";

/** @deprecated Legacy facts mapping; native facts are owned by the client product. */
export { mapAnnouncedSubmissionToFacts } from "./facts-mapper.js";
/**
 * @deprecated Frozen bridge-era legacy kind, not a native record kind. Native cards use
 * `RECORD_KINDS.submission` from Record Discovery Protocol; this value is intentionally
 * distinct from it and outside the record-kind grammar.
 */
export { RECORD_KINDS_SUBMISSION } from "./facts-mapper-kinds.js";
/** @deprecated Use the policy-neutral helpers from task-execution-backend. */
export {
  validateRequirementsAgainstRunPinning,
  verifyPreclaim,
} from "./preclaim.js";
/** @deprecated Use the policy-neutral types from task-execution-backend. */
export type { PreclaimNotClaimedReason, PreclaimResult } from "./preclaim.js";
/** @deprecated Legacy facts mapping types; native facts are owned by the client product. */
export type {
  AnnouncedSubmissionCard,
  FactsMapperOptions,
  FactsMappingRefusal,
  FactsMappingResult,
  NativeDiscoveryCardProvenance,
} from "./facts-mapper.js";
