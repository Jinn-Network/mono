/**
 * @jinn-network/jinn-layer — standalone plugin process and embeddable layer.
 *
 * v0 exposes the corpus consume path (search/get), the frozen layer-1 trace
 * envelope read-compat schema, the capture path (scrub + preview), and the publish path
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
  corpusProbes,
  enoughCorpusForRepo,
  CORPUS_ONBOARDING_K,
  type DoctorCheck,
} from './corpus-probes.js';

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
  publishManifestBatch,
  PublishLedgerError,
  toPublishedEpisode,
  toTraceEnvelope,
  EPISODE_ARTIFACT_TYPE,
  TRACE_ENVELOPE_ARTIFACT_TYPE,
  type HarnessPublishDeps,
  type ManifestBatchPublishDeps,
  type ManifestBatchSetResult,
  type PublishedResult,
  type PublishOptions,
  type PublishResult,
} from './publish.js';

export { createEvidenceFetcher } from './bridge-fetch-evidence.js';

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
} from '@jinn-network/core';

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
  type SkillLifecycle,
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
  createLocalDistiller,
  createNetworkDistiller,
  createLocalSkillSink,
  NetworkDistillerNotWiredError,
  type Distiller,
  type DistillerResult,
  type LocalDistillerDeps,
  type SkillSink,
  type HeldOutSlate,
} from './distiller.js';

export {
  createClaudeDistiller,
  createClaudeMetaDistiller,
  createCodexDistiller,
  createCodexMetaDistiller,
  DEFAULT_MODEL as DEFAULT_CLAUDE_DISTILL_MODEL,
  DEFAULT_CODEX_MODEL,
  DISTILLER_CATALOG,
} from './distill-llm.js';

export {
  readDistillMode,
  writeDistillMode,
  DEFAULT_DISTILL_MODE_PATH,
  type DistillMode,
  type DistillModeState,
} from './distill-mode.js';

export {
  DEFAULT_CAPTURES_DIR,
  DEFAULT_DISTILL_CAPTURE_LIMIT,
  DEFAULT_EPISODES_DIR,
  DEFAULT_SKILLS_INSTALL_DIR,
  coveredSessionIds,
  episodeToCapturedTask,
  localSkillProvenance,
  loadRecentCaptures,
  loadRecentDistillSources,
  provenanceLabels,
  stagingDirFor,
  type DistillSourceOptions,
} from './distill-captures.js';

export {
  clusterTraceCards,
  readTrace,
  searchTraceCards,
  traceCardFromCapture,
  type EvidenceTierEstimate,
  type EstimatedDistillCost,
  type LocalTraceCard,
  type TraceCandidate,
  type TraceEventView,
  type TraceReadMode,
  type TraceReadResult,
  type TraceSearchQuery,
} from './distill-traces.js';

export {
  createDistillMcpServer,
  runLocalDistill,
  type DistillMcpDeps,
  type LocalDistillRunArgs,
} from './distill-mcp-server.js';

export {
  DEFAULT_DISTILL_FEEDBACK_PATH,
  distillFeedbackPathFromEnv,
  readDistillFeedback,
  recordDistillFeedback,
  type DistillFeedbackInput,
  type DistillFeedbackRecord,
  type DistillFeedbackVerdict,
} from './distill-feedback.js';

export {
  threeArmMeasurement,
  pilotPower,
  type ArmResult,
  type ArmComparison,
  type PilotPower,
  type ThreeArmResult,
  type ShipVerdict,
} from './measurement.js';

export {
  createFileLedger,
  createMemoryLedger,
  ledger,
  toLedgerRow,
  LedgerEntrySchema,
  LedgerRowSchema,
  DEFAULT_LEDGER_PATH,
  type LedgerEntry,
  type LedgerRow,
  type LedgerStore,
} from './ledger.js';

export {
  createGithubSeedSource,
  parseSeedListEntry,
  SeedSkillSchema,
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

// Evidence-episode seed lane (issue #1771).
export {
  createLocalEpisodeSeedSource,
  episodeContentDigest,
  parseSeedEpisode,
  SeedEpisodeSchema,
  SEED_EPISODE_EXCERPT_LABELS,
  type SeedEpisode,
  type SeedEpisodeStep,
  type SeedEpisodeExcerptLabel,
  type EpisodeSource,
} from './seed-import/episode-fetch.js';
export { planEpisodes } from './seed-import/episode-plan.js';
export { executeEpisodes, type EpisodeImportResult } from './seed-import/episode-execute.js';
export {
  parseEpisodeImportReport,
  renderEpisodeImportReport,
  EpisodeImportReportSchema,
  type EpisodeImportReport,
  type EpisodeImportReportRow,
} from './seed-import/episode-report.js';
export {
  createMemorySeedImportState,
  createFileSeedImportState,
  hashSeedContent,
  DEFAULT_SEED_IMPORT_STATE_PATH,
  type SeedImportStateStore,
  type SeedPublicationRecord,
  type FileSeedImportStateOptions,
} from './seed-import/state.js';

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

export {
  CONTRIBUTION_STORE_FILE,
  CONTRIBUTION_STORE_SCHEMA_VERSION,
  CONTRIBUTION_PUBLICATION_SCHEMA_VERSION,
  CONTRIBUTION_PUBLICATION_DISABLED_FILE,
  DEFAULT_CONTRIBUTION_STATE_DIR,
  ContributionStore,
  resolveContributionStateDir,
  type ContributionLocalMetadata,
  type ContributionPublicationV1,
  type ContributionStoreLockOptions,
  type ContributionStoreOptions,
  type ContributionStoreRecordOptions,
  type ContributionStoreReferenceOptions,
  type ContributionStoreRecord,
} from '@jinn-network/core';

export {
  PROCESS_CONTRACT_VERSION,
  SessionEndRequestV1Schema,
  SessionPickupRequestV1Schema,
  envelope as processEnvelope,
  sessionEndEnvelope,
  type ProcessEnvelope,
  type ProcessStatus,
  type SessionEndRequestV1,
  type SessionPickupEnvelope,
  type SessionPickupRequestV1,
  contributionLedgerRow,
  type ContributionLedgerRowV1,
} from './process-contract.js';

export {
  resolveRetrievalMark,
  HAND_MARK_POLICY,
  type AdmissionPolicy,
  type AdmissionFacts,
} from './admission-policy.js';

export {
  runJinnLayerCli,
  createBoundedIpfsJsonFetcher,
  type RunJinnLayerCliOptions,
  type DistillRunCliDeps,
  type DistillCliDeps,
  type DistillProvider,
  type JinnLayerWriter,
} from './cli.js';

export {
  buildPluginDepsFromEnv,
  buildPluginFromEnv,
} from './plugin-wiring.js';

export {
  createContributionAdapter,
  createContributionStatusStore,
  createCorpusAdapter,
  createEvidenceAdapter,
  createLocalLearningAdapter,
  createSkillsAdapter,
} from './adapters/index.js';

export { SqliteCorpusStore } from './corpus-store.js';

export {
  extractSnapshotTranscript,
  findSolveTranscript,
  untarGz,
  unwrapDonation,
  MAX_SNAPSHOT_DECOMPRESSED_BYTES,
  type SolveTranscript,
  type TarEntry,
} from './snapshot-transcript.js';

export {
  auditCuratedSeedBatch,
  CURATED_SEED_AUDIT_SCHEMA_VERSION,
  type AuditCuratedSeedBatchOptions,
  type CuratedSeedBatchAudit,
  type CuratedSeedRecordAudit,
} from './seed-import/curated-batch.js';
