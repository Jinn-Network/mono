// @jinn-network/benchmarking-aggregate — consumer-side aggregation (design §9, plan M3).
// Never imports `run` (tenet 4: the method registry + statistics are a tier-3 concern only; the
// Matrix carries no aggregate of any kind). Dependency boundary: records + trust-core only.

// --- the method registry + local types (design §9.2, §14.7) ---
export { BENCHMARKING_METHOD_REGISTRY, createMethodRegistry } from "./registry.js";
export type {
  AnchoredBenchmarkAnnouncementVerification,
  AnchoredBenchmarkAnnouncementVerificationInput,
  AnchoredBenchmarkAnnouncementVerifier,
  Method,
  MethodComputeInput,
  MethodResults,
  MethodRegistry,
  MethodSubject,
  SubjectMethodResult,
  VerdictOutcome,
  VerdictRuleName,
} from "./method.js";
export { MethodInputError } from "./resolved-inputs.js";
export type { MethodInputErrorCode } from "./resolved-inputs.js";

// --- the contract-wide verdictRule reduction (design §9.2) ---
export { reduceValidVerdicts } from "./verdict-rule.js";
export type { VerdictReduction } from "./verdict-rule.js";

// --- the §9.3 exclusion discipline structural gate ---
export { selectScorableCells } from "./exclusion.js";
export type { CellRef, ExcludedReport } from "./exclusion.js";

// --- the contamination-filter predicate (clean-subset@1) ---
export { filterByCutoff } from "./clean-subset.js";
export type { CleanSubsetBasis, CleanSubsetFilterResult } from "./clean-subset.js";

// --- binary-instrument scientific replicate reduction ---
export { BinaryInstrumentReductionError, reduceBinaryInstrumentReplicates } from "./binary-instrument.js";
export type {
  BinaryInstrumentDecision,
  BinaryInstrumentExcludedItem,
  BinaryInstrumentExclusionDetail,
  BinaryInstrumentExclusionReason,
  BinaryInstrumentExpectedContext,
  BinaryInstrumentExpectedInstrument,
  BinaryInstrumentItemContext,
  BinaryInstrumentItemDecision,
  BinaryInstrumentParsedCellInput,
  BinaryInstrumentReducedCall,
  BinaryInstrumentReduction,
  BinaryInstrumentReductionErrorCode,
  BinaryInstrumentReductionInput,
  BinaryInstrumentStratum,
  BinaryInstrumentTruthLabel,
} from "./binary-instrument.js";
export {
  BINARY_INSTRUMENT_MEASUREMENT_PROFILE,
  BINARY_INSTRUMENT_MEASUREMENTS,
  BINARY_INSTRUMENT_PARAMETER_SCHEMA,
  validateBinaryInstrumentQualificationProjection,
  validateBinaryInstrumentParameters,
} from "./binary-instrument-method.js";
export type { BinaryInstrumentParameters } from "./binary-instrument-method.js";

// --- the reference statistics library (design §9.2, adopted from the capability-eval seed) ---
export { wilsonInterval } from "./stats/wilson.js";
export type { WilsonInterval } from "./stats/wilson.js";
export { avgAtOne, passAtK } from "./stats/pass-at-k.js";
export { clusterBy } from "./stats/clustering.js";
export { clusteredVariance, mcnemarExact, pairedMcnemar } from "./stats/paired-mcnemar.js";
export type { ClusteredVariance, DiscordantPair, PairedMcnemarResult } from "./stats/paired-mcnemar.js";
export { clusteredPairedDeltaInterval } from "./stats/paired-delta.js";
export type { PairedDeltaIntervalOptions, PairedDeltaIntervalResult } from "./stats/paired-delta.js";
export { provenanceClusterSign } from "./stats/provenance-cluster-sign.js";
export type {
  ProvenanceClusterPair,
  ProvenanceClusterSignResult,
  ProvenanceClusterVote,
} from "./stats/provenance-cluster-sign.js";
export {
  nonInferiorityIut,
  MAX_NONINFERIORITY_RESAMPLES_V1,
  nonInferiorityVerdict,
  pairedCostVerdict,
  pairedRateDiffLowerBound,
  xorshift32,
} from "./stats/noninferiority.js";
export type {
  CostVerdictResult,
  NonInferiorityIutVerdict,
  NonInferiorityOptions,
  NonInferiorityResult,
  QualityVerdict,
  RateCiOptions,
  TaskRates,
} from "./stats/noninferiority.js";
export { fitBradleyTerry } from "./stats/bradley-terry.js";
export type { BradleyTerryResult, PairwiseWin } from "./stats/bradley-terry.js";

// --- Report production + verification (design §9.1, §12.1) ---
export { deriveDisclosures, produceReport, produceReportV2, verifyReport, verifyReportV2 } from "./report.js";
export type {
  Disclosures,
  DsseSigner,
  MethodPorts,
  ProduceReportV2Input,
  ProduceReportInput,
  ProducedReport,
  ProducedReportV2,
  PublicRegistrationCheck,
  PublicRegistrationDisclosure,
  PublicRegistrationInput,
  PublicRegistrationStatus,
  ReportPublicationExtension,
  VerifyReportCheck,
  VerifyReportInput,
  VerifyReportPorts,
  VerifyReportResult,
  VerifyReportV2Check,
  VerifyReportV2Input,
  VerifyReportV2Result,
} from "./report.js";
