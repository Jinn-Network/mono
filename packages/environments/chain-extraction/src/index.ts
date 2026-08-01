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
  stateArtifactKeySet,
  type StateArtifact,
  type StateArtifactAccount,
} from "./artifact.js";

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
