/**
 * @jinn-network/harness-layer — embeddable harness-layer surface.
 *
 * v0 exposes the corpus consume path (search/get), the frozen layer-1 trace
 * envelope schema, the capture path (scrub + preview), and the publish path
 * (consent conversion + anchor + contribution ledger).
 */

export {
  createHarnessLayer,
  DEFAULT_IPFS_GATEWAY_URL,
  type HarnessLayer,
  type HarnessLayerConfig,
  type ResolvedHarnessLayerConfig,
  type CorpusSearchHit,
  type CorpusRecord,
  type CorpusArtifact,
} from './consume.js';

export {
  capture,
  parseCapturedTask,
  CapturedTaskSchema,
  CaptureScrubError,
  PENDING_ENVELOPE_KIND,
  type CapturedTask,
  type CaptureOptions,
  type PendingEnvelope,
  type ScrubRedaction,
} from './capture.js';

export {
  preview,
  stripBeforeValues,
  type ScrubReport,
} from './preview.js';

export {
  computeSignal,
  type SignalInput,
  type SignalRow,
  type SignalOptions,
} from './signal.js';

export {
  publish,
  toTraceEnvelope,
  TRACE_ENVELOPE_ARTIFACT_TYPE,
  type HarnessPublishDeps,
  type PublishOptions,
  type PublishResult,
} from './publish.js';

export {
  extractSkill,
  type ExtractedSkill,
} from './skill.js';

export {
  SKILL_ARTIFACT_TYPE,
  SkillArtifactV1Schema,
  SkillProvenanceSchema,
  SkillCompanionFileSchema,
  MAX_SKILL_FILES,
  MAX_SKILL_TOTAL_DECODED_BYTES,
  type SkillArtifactV1,
  type SkillProvenance,
  type SkillCompanionFile,
} from '../../../src/types/skill-artifact.js';

export {
  buildSkillMarkdown,
  parseSkillMarkdown,
  assertConformantName,
  SkillPackageMetaSchema,
  type SkillPackage,
  type SkillPackageMeta,
} from './skill-package.js';

export {
  publishSkill,
  toSkillArtifactV1,
  SKILL_SOLVER_TYPE,
  type SkillPublishDeps,
  type PublishSkillResult,
} from './publish-skill.js';

export {
  bridgeAttempts,
  toBridgeCapturedTask,
  repoFromInstanceId,
  buildBridgeEvidencePublisher,
  type AttemptRef,
  type BridgeEvidence,
  type BridgeDeps,
  type BridgeResult,
} from './bridge.js';

export {
  evaluateEligibility,
  redactionHealth,
  type EligibilityTier,
  type EligibilityResult,
  type RedactionHealth,
} from './gate.js';

export {
  distillClusters,
  lexicalContaminationScan,
  type DistillCluster,
  type DistillLLMOutput,
  type DistillDeps,
  type DistillResult,
} from './distill.js';

export {
  createLivePublishDeps,
  DEFAULT_TESTNET_IDENTITY_REGISTRY,
  DEFAULT_TESTNET_RPC_URL,
  type LivePublishConfig,
} from './publish-live.js';

export {
  createFileLedger,
  createMemoryLedger,
  ledger,
  LedgerEntrySchema,
  DEFAULT_LEDGER_PATH,
  type LedgerEntry,
  type LedgerStore,
} from './ledger.js';

export {
  createGithubSeedSource,
  parseSeedListEntry,
  type SeedSkill,
  type SeedSource,
  type SeedListEntry,
} from './seed-import/fetch.js';
export { checkLicence, IMPORT_LICENCE_ALLOWLIST, type LicenceVerdict } from './seed-import/licence.js';
export { plan } from './seed-import/plan.js';
export { execute, skillSlug, type ImportResult } from './seed-import/execute.js';
export {
  parseImportReport,
  renderImportReport,
  ImportReportSchema,
  type ImportReport,
  type ImportReportRow,
} from './seed-import/report.js';

export {
  TraceEnvelopeV0Schema,
  TraceStepSchema,
  VerifiabilityTierSchema,
  OutcomeStatusSchema,
  parseTraceEnvelopeV0,
  TRACE_ENVELOPE_SCHEMA_VERSION,
  MAX_STEPS,
  MAX_STEP_ATTRIBUTES_BYTES,
  MAX_DISTRIBUTION_TAGS,
  VERIFIABILITY_TIERS,
  type TraceEnvelopeV0,
  type TraceStep,
  type VerifiabilityTier,
  type OutcomeStatus,
} from './envelope.js';
