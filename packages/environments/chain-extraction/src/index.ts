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
  stageForExtractionFailure,
  type ExtractionFailureDisposition,
  type ExtractionFailureReason,
  type ExtractionStage,
} from "./failures.js";
