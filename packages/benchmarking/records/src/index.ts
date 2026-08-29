// @jinn-network/benchmarking-records — public surface (frozen at the design §14.1-.6 granularity).
// The four sealed benchmarking record kinds (Benchmark, Run, Matrix, Report), their sealing, and
// their record-level checks. Tier 2; imports task-execution-protocol and trust-core only.

// --- pinned identifiers (protocol, media types, record-kind URIs, method URIs, scope) ---
export {
  ANCHOR_INTENT_EXTENSION,
  TASK_SELECTION_EXTENSION,
  ASSEMBLY_PROCEDURE,
  ASSEMBLY_PROCEDURE_VERSION,
  BENCHMARK_ACCOUNTING_MEDIA_TYPE,
  BENCHMARK_ACCOUNTING_PROCEDURE,
  BENCHMARK_ACCOUNTING_PROCEDURE_VERSION,
  BENCHMARK_ACCOUNTING_RECORD_KIND,
  BENCHMARK_MEDIA_TYPE,
  BENCHMARK_OBSERVATION_ARCHIVE_MEDIA_TYPE,
  BENCHMARK_OBSERVATION_ARCHIVE_PROFILE,
  BENCHMARK_PUBLICATION_EXTENSION,
  BENCHMARK_RECORD_KIND,
  BENCHMARKING_METHOD_IDS,
  BENCHMARKING_METHOD_VERSION,
  BENCHMARKING_PROTOCOL,
  BENCHMARKING_REPORTS_SCOPE,
  MATRIX_MEDIA_TYPE,
  MATRIX_ASSEMBLY_PROCEDURE,
  MATRIX_ASSEMBLY_PROCEDURE_VERSION,
  MATRIX_RECORD_KIND,
  REPORT_MEDIA_TYPE,
  REPORT_RECORD_KIND,
  REPORT_V2_RECORD_KIND,
  RUN_MEDIA_TYPE,
  RUN_RECORD_KIND,
  SIGNED_REPORT_MEDIA_TYPE,
  TRUST_AUTHORIZATION_RECORD_KIND,
  TRUST_POLICY_PURPOSE_BENCHMARK_PUBLISHER,
  TRUST_POLICY_PURPOSE_RUN_OWNER,
} from "./identifiers.js";

// --- sealing primitives (order, hashing, canonicalization, I-JSON) ---
export { compareCodeUnitStrings } from "./order.js";
export { exactDecimalInUnitInterval, meetsExactDecimalFloor, parseExactDecimal, scaleDecimal } from "./decimal.js";
export type { ExactDecimal } from "./decimal.js";
export { documentDigest, sha256Hex } from "./hashing.js";
export { serializeCanonicalJson } from "./canonical.js";
export {
  IJsonNumberError,
  IJsonStringError,
  UndefinedArrayElementError,
  assertIJsonInteger,
  assertIJsonString,
  assertIJsonStrings,
} from "./json.js";
export type { JsonValue } from "./json.js";
export {
  compareCalendarStrictRfc3339Instants,
  isCalendarStrictRfc3339,
} from "./rfc3339.js";
export { InvalidDocumentError, sealRecord, sealWithSchema } from "./sealing.js";
export type { SealedRecord, ValidationIssue } from "./sealing.js";
export {
  AgentIriSchema,
  DigestBearingResourceDescriptorSchema,
  LowercaseSha256HexSchema,
} from "./descriptors.js";
export type { DigestBearingResourceDescriptor } from "./descriptors.js";

// --- benchmark-publication/v1 extension helpers ---
export {
  MatrixPublicationExtensionSchema,
  RegistrationArtifactSchema,
  RunPublicationExtensionSchema,
  matrixPublicationExtension,
  readMatrixPublicationExtension,
  readRunPublicationExtension,
  runPublicationExtension,
  withMatrixPublicationExtension,
  withRunPublicationExtension,
} from "./publication-extension.js";
// --- anchor-intent/v1 extension helpers (anchor-evidence design §7.3) ---
export {
  ANCHOR_PROFILE_NAMESPACE,
  RunAnchorIntentExtensionSchema,
  readRunAnchorIntentExtension,
  runAnchorIntentExtension,
  withRunAnchorIntentExtension,
} from "./anchor-intent-extension.js";
export type { RunAnchorIntentExtension } from "./anchor-intent-extension.js";

export {
  TASK_SELECTION_MODES,
  RunTaskSelectionExtensionSchema,
  TaskSelectionModeSchema,
  readRunTaskSelectionExtension,
  readTaskSelectionMode,
  runTaskSelectionExtension,
  withRunTaskSelectionExtension,
} from "./task-selection.js";
export type { RunTaskSelectionExtension, TaskSelectionMode } from "./task-selection.js";

export type {
  MatrixPublicationExtension,
  RegistrationArtifact,
  RunPublicationExtension,
} from "./publication-extension.js";

// --- the Benchmark record (§6) ---
export { BenchmarkRecordSchema, itemTaskDigest, parseBenchmark, sealBenchmark } from "./benchmark/schema.js";
export type { BenchmarkItem, BenchmarkRecord } from "./benchmark/schema.js";
export {
  checkBenchmarkPredecessor,
  checkBenchmarkTransition,
  checkComparability,
  checkItemDistinctness,
  checkJudgeability,
  classifyVersionBump,
  resolveBenchmarkTaskProvenance,
} from "./benchmark/checks.js";
export type {
  BenchmarkPredecessorCheck,
  BenchmarkTransitionCheck,
  JudgeabilityInvalidItem,
  JudgeabilityRevealContext,
  TaskBytesResolver,
  BenchmarkTaskProvenance,
  VersionBump,
} from "./benchmark/checks.js";
export { checkRevealConsistency } from "./benchmark/reveal.js";
export type { RevealCoverage } from "./benchmark/reveal.js";

// --- the Run record (§7): cellKey grammar, expected-cell-set, Submission extension block ---
export { RunRecordSchema, parseRun, sealRun } from "./run/schema.js";
export type { RunArm, RunRecord } from "./run/schema.js";
export {
  ArmIdSchema,
  CellKeySchema,
  ReplicateSchema,
  TaskDigestHexSchema,
  cellIdempotencyKey,
  cellKey,
  expectedCellCount,
  expectedCellSet,
  MAX_MATERIALIZED_CELLS,
  parseCellKey,
  submissionExtensionBlock,
} from "./run/cells.js";
export type { CellCoord, CellDispatchAnnotations } from "./run/cells.js";

// --- the Matrix record (§8): frozen outcome vocabulary ---
export { MatrixRecordSchema, OUTCOME_VOCABULARY, parseMatrix, sealMatrix } from "./matrix/schema.js";
export type { MatrixCell, MatrixRecord, Outcome } from "./matrix/schema.js";

// --- the Report record (§9.1) ---
export { ReportRecordSchema, parseReport, parseSignedReportRecord, sealReport } from "./report/schema.js";
export type { ReportRecord, SignedReportRecord } from "./report/schema.js";

// --- BenchmarkAccounting and observation archive (benchmark-publication/v1) ---
export {
  AccountingScopeStreamSchema,
  BenchmarkAccountingRecordSchema,
  ObservationArchiveSchema,
  PublisherAuthorizationReferenceSchema,
  PublisherAuthoritySchema,
  RegistrationBoundarySchema,
  TypedRecordReferenceSchema,
  parseBenchmarkAccounting,
  parseObservationArchive,
  sealBenchmarkAccounting,
  sealObservationArchive,
} from "./accounting/schema.js";
export type {
  AccountingScopeStream,
  BenchmarkAccountingCell,
  BenchmarkAccountingDispatch,
  BenchmarkAccountingRecord,
  ObservationArchive,
  ObservationArchiveStream,
  ObservationConflict,
  PublisherAuthorizationReference,
  PublisherAuthority,
  RegistrationBoundary,
  TypedRecordReference,
} from "./accounting/schema.js";
export {
  checkBenchmarkAccounting,
  checkObservationArchive,
  checkPublicRegistrationOrder,
} from "./accounting/checks.js";
export type { PublicationCheckResult } from "./accounting/checks.js";

// --- fixture loaders (golden + reveal + equivalence, §16) ---
export {
  loadEquivalenceExpectedDigest,
  loadEquivalenceInput,
  loadGoldenBytes,
  loadGoldenDigest,
  loadGoldenJson,
  loadRevealCommitted,
  loadRevealedMap,
  loadRevealExpectedCoverage,
} from "./fixtures.js";
export type { RecordKind, RevealScenario } from "./fixtures.js";
