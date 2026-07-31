// SPDX-License-Identifier: Apache-2.0

export { DerivationError } from "./errors.js";
export type { DerivationErrorCategory } from "./errors.js";
export { compareCodeUnitStrings } from "./order.js";
export { canonicalJsonBytes, serializeCanonicalJson } from "./canonical.js";
export type { CanonicalJsonValue } from "./canonical.js";
export {
  assertBareHex,
  assertPrefixedDigest,
  digestsEqual,
  documentDigest,
  sha256Hex,
  toBareHex,
} from "./digest.js";
export type { Sha256Digest } from "./digest.js";
export {
  SOURCE_COMMITMENT_RULE,
  computeSourceCommitment,
  sourceCommitmentPreImage,
  statementDigest,
} from "./source-commitment.js";
export type { UpstreamIdentity } from "./source-commitment.js";
export {
  ENVIRONMENT_RECORD_EXTENSION_KEY,
  buildEnvironmentRecordExtension,
  readEnvironmentRecordExtension,
} from "./environment-extension.js";
export type { EnvironmentRecordExtension } from "./environment-extension.js";
export { SPDX_EXPRESSION_PATTERN, assertCandidate } from "./candidate.js";
export type {
  Candidate,
  CandidateProvenance,
  CandidateTestMaterial,
  ProvenanceKind,
} from "./candidate.js";
export { loadDerivationEnvironment } from "./strategy.js";
export type {
  DerivationEnvironment,
  DerivationLogger,
  DerivationStrategy,
  StrategyDeps,
} from "./strategy.js";
export { buildCandidateEvaluationSpec, buildSealedTask } from "./seal-pair.js";
export type { SealedEvaluationSpec, SealedTask } from "./seal-pair.js";
export {
  IMPORT_STRATEGY_ID,
  PERMISSIVE_LICENSE_ALLOWLIST,
  assessRow,
  importStrategy,
} from "./strategies/import.js";
export type {
  ImportStrategyInputs,
  RowRejection,
  UpstreamRebenchRow,
} from "./strategies/import.js";
export {
  POOL_ENTRY_SCHEMA_VERSION,
  PoolEntryManifestSchema,
  assertEntryDigests,
  parsePoolEntryManifest,
  poolEntryConflictKeyBytes,
  poolEntryManifestBytes,
} from "./pool.js";
export type {
  PoolEntry,
  PoolEntryProvenance,
  PoolEntrySummary,
  SupplyPool,
} from "./pool.js";
export { createFilesystemSupplyPool } from "./pool/filesystem.js";
export type { FilesystemSupplyPoolOptions } from "./pool/filesystem.js";
export type { GoldRef, GoldStore } from "./gold.js";
export { GOLD_STORE_MARKER_FILE, createFilesystemGoldStore } from "./gold/filesystem.js";
export type { FilesystemGoldStoreOptions } from "./gold/filesystem.js";
export { runDerivation } from "./run.js";
export type {
  AdmissionPort,
  AdmissionRequest,
  DerivationDeps,
  FailedCandidate,
  PoolWriteSummary,
  RefusedCandidate,
  WrittenPair,
} from "./run.js";
