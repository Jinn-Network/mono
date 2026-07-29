// @jinn-network/benchmarking-records — public surface (frozen at the design §14.1-.6 granularity).
// The four sealed benchmarking record kinds (Benchmark, Run, Matrix, Report), their sealing, and
// their record-level checks. Tier 2; imports task-execution-protocol only (plan Finding F3).

// --- pinned identifiers (protocol, media types, record-kind URIs, method URIs, scope) ---
export {
  ASSEMBLY_PROCEDURE,
  ASSEMBLY_PROCEDURE_VERSION,
  BENCHMARK_MEDIA_TYPE,
  BENCHMARK_RECORD_KIND,
  BENCHMARKING_METHOD_IDS,
  BENCHMARKING_METHOD_VERSION,
  BENCHMARKING_PROTOCOL,
  BENCHMARKING_REPORTS_SCOPE,
  MATRIX_MEDIA_TYPE,
  MATRIX_RECORD_KIND,
  REPORT_MEDIA_TYPE,
  REPORT_RECORD_KIND,
  RUN_MEDIA_TYPE,
  RUN_RECORD_KIND,
  TRUST_POLICY_PURPOSE_BENCHMARK_PUBLISHER,
  TRUST_POLICY_PURPOSE_RUN_OWNER,
} from "./identifiers.js";

// --- sealing primitives (order, hashing, canonicalization, I-JSON) ---
export { compareCodeUnitStrings } from "./order.js";
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
export { InvalidDocumentError, sealRecord, sealWithSchema } from "./sealing.js";
export type { SealedRecord, ValidationIssue } from "./sealing.js";
export {
  AgentIriSchema,
  DigestBearingResourceDescriptorSchema,
  LowercaseSha256HexSchema,
} from "./descriptors.js";
export type { DigestBearingResourceDescriptor } from "./descriptors.js";

// --- the Benchmark record (§6) ---
export { BenchmarkRecordSchema, itemTaskDigest, parseBenchmark, sealBenchmark } from "./benchmark/schema.js";
export type { BenchmarkItem, BenchmarkRecord } from "./benchmark/schema.js";
export {
  checkBenchmarkPredecessor,
  checkComparability,
  checkItemDistinctness,
  checkJudgeability,
  classifyVersionBump,
} from "./benchmark/checks.js";
export type {
  BenchmarkPredecessorCheck,
  JudgeabilityInvalidItem,
  TaskBytesResolver,
  VersionBump,
} from "./benchmark/checks.js";
export { checkRevealConsistency } from "./benchmark/reveal.js";
export type { RevealCoverage } from "./benchmark/reveal.js";

// --- the Run record (§7): cellKey grammar, expected-cell-set, Submission extension block ---
export { RunRecordSchema, parseRun, sealRun } from "./run/schema.js";
export type { RunArm, RunRecord } from "./run/schema.js";
export {
  cellIdempotencyKey,
  cellKey,
  expectedCellCount,
  expectedCellSet,
  parseCellKey,
  submissionExtensionBlock,
} from "./run/cells.js";
export type { CellCoord, CellDispatchAnnotations } from "./run/cells.js";

// --- the Matrix record (§8): frozen outcome vocabulary ---
export { MatrixRecordSchema, OUTCOME_VOCABULARY, parseMatrix, sealMatrix } from "./matrix/schema.js";
export type { MatrixCell, MatrixRecord, Outcome } from "./matrix/schema.js";

// --- the Report record (§9.1) ---
export { ReportRecordSchema, parseReport, sealReport } from "./report/schema.js";
export type { ReportRecord } from "./report/schema.js";

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
