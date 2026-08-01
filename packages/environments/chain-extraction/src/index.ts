// SPDX-License-Identifier: Apache-2.0

export {
  BASELINE_RUN_COUNT,
  CHAIN_EXTRACTION_PROTOCOL_URI,
  DEFAULT_ARCHIVE_BUDGET,
  DEFAULT_MAX_WIDENINGS,
  MAX_WIDENINGS_CEILING,
} from "./identifiers.js";

export {
  CHAIN_EXTRACTION_ERROR_CODES,
  ChainExtractionError,
  conformanceFailure,
  invalidInput,
  type ChainExtractionErrorCode,
} from "./errors.js";

export {
  EXTRACTION_FAILURE_DISPOSITIONS,
  EXTRACTION_FAILURE_REASONS,
  EXTRACTION_STAGES,
  classifyExtractionFailure,
  isRetryableExtractionFailure,
  stageFail,
  stageForExtractionFailure,
  stageOk,
  type ExtractionFailureDisposition,
  type ExtractionFailureReason,
  type ExtractionStage,
  type StageOutcome,
} from "./failures.js";

export {
  establishBaseline,
  type ChainEnvironmentRecordDraft,
  type ConnectedBaseline,
  type ExtractionRequest,
} from "./baseline.js";

export {
  harvestTouchedState,
  type HarvestOptions,
  type HarvestResult,
} from "./harvest.js";

export {
  captureAnchor,
  confirmAnchorUnchanged,
  type AnchorCapture,
  type AnchorFinalityObservation,
  type AnchorRequest,
  type HeaderProofCarrier,
  type HeaderProofDescriptor,
} from "./anchor.js";

export {
  HexAddressSchema,
  Hex32Schema,
  HexBytesSchema,
  HexQuantitySchema,
  isEmptyBytes,
  normalizeAddress,
  normalizeBytes,
  normalizeHex32,
  normalizeQuantity,
  normalizeSlot,
  type Hex32,
  type HexAddress,
  type HexBytes,
  type HexQuantity,
} from "./hex.js";

export {
  differenceKeySets,
  emptyKeySet,
  keySetDigest,
  keySetIsEmpty,
  keySetSize,
  keySetWithAccount,
  keySetWithCode,
  keySetWithSlot,
  unionKeySets,
  type StateKeySet,
} from "./key-set.js";

export {
  createBudgetedArchivePort,
  type BudgetedArchivePort,
} from "./budget.js";

export {
  STATE_ARTIFACT_FORMAT,
  StateArtifactAccountSchema,
  StateArtifactSchema,
  mergeIntoStateArtifact,
  parseStateArtifact,
  serializeStateArtifact,
  stateArtifactDigest,
  stateArtifactEntryCount,
  stateArtifactEntryCounts,
  stateArtifactKeySet,
  type StateArtifact,
  type StateArtifactAccount,
} from "./artifact.js";

export {
  FIXTURE_COVERAGE_FORMAT,
  PROOF_BUNDLE_FORMAT,
  buildCoverageArtifacts,
  collectSourceProofs,
  type CoverageArtifacts,
  type CoverageInput,
  type FixtureCoverageDocument,
  type ProofBundle,
} from "./coverage.js";

export { decodeRlp, type RlpItem } from "./rlp.js";

export { verifyAccountProof, type ProofVerdict } from "./proof.js";

export {
  asChainStateBackend,
  type ArchiveAccountProof,
  type ArchiveAccountState,
  type ArchiveBlockHeader,
  type ArchiveRpcPort,
  type ArchiveUsage,
  type ArtifactStore,
  type BlockSelector,
  type ChainRuntime,
  type ChainStateBackend,
  type ChainStateDump,
  type Clock,
  type ExtractionDeps,
  type ForkBackendBinding,
  type ScriptReplayer,
  type StateDumpPort,
  type VerifiedChainMaterializer,
  type VerifierIdentity,
} from "./ports.js";

export type { FixtureMutationDeclaration } from "@jinn-network/chain-environment-verification";

export {
  PROVISIONAL_COMMITMENT,
  assertClosedStatePreconditions,
  assembleCandidate,
  buildClosedStateRecord,
  computeSealedInitialCommitment,
  resolveClosedStateResources,
  storeExtractionArtifacts,
  type AssembleCandidateInput,
  type ChainEnvironmentCandidate,
} from "./candidate.js";

export {
  extractEnvironment,
  type ExtractionResult,
} from "./extract.js";

export {
  createLayeredStateBackend,
  localizeMissingState,
  widenAndReverify,
  type ConvergenceResult,
  type LayeredStateBackend,
  type WidenOptions,
  type WideningRound,
} from "./widen.js";

export {
  EXTRACTION_JOB_DISPOSITIONS,
  MAX_INFRASTRUCTURE_ATTEMPTS,
  advanceExtractionJob,
  createExtractionStateFile,
  dueExtractionJobs,
  extractionJobKey,
  parseExtractionStateFile,
  recordExtractionConverged,
  recordExtractionFailure,
  recordExtractionSpend,
  remainingBudget,
  serializeExtractionStateFile,
  upsertExtractionJobs,
  type ExtractionJob,
  type ExtractionJobDisposition,
  type ExtractionStateFile,
  type ExtractionStateStore,
} from "./extraction-state.js";

export { createFileExtractionStateStore } from "./extraction-state-store.js";
