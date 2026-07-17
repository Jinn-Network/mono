// packages/plugin/src/index.ts
// Public entry — grows incrementally as ports/schemas/factory land (S1-F1).
export type { PortResult } from './outcome.js';
export { ok, degraded, unavailable, valueOr, unwrap } from './outcome.js';
export { EPISODE_SCHEMA_VERSION, EpisodeV1Schema, SessionActivityFactsSchema } from './schemas/episode.js';
export type { EpisodeV1, SessionActivityFacts } from './schemas/episode.js';
export {
  CONTRIBUTION_CANDIDATE_SCHEMA_VERSION,
  ContributionCandidateV1Schema,
} from './schemas/contribution-candidate.js';
export type { ContributionCandidateV1 } from './schemas/contribution-candidate.js';
export { KnowledgeHitSchema } from './schemas/knowledge-hit.js';
export type { KnowledgeHit } from './schemas/knowledge-hit.js';
export { EligibilityVerdictSchema } from './schemas/eligibility-verdict.js';
export type { EligibilityVerdict } from './schemas/eligibility-verdict.js';
export { SessionSummarySchema } from './schemas/session-summary.js';
export type { SessionSummary } from './schemas/session-summary.js';
export { HistoryEntrySchema } from './schemas/history-entry.js';
export type { HistoryEntry } from './schemas/history-entry.js';
export type { CorpusPort, CorpusRecord, CorpusRecordStep } from './ports/corpus-port.js';
export type { EvidencePort, EvidenceListQuery, EvidenceRetentionPolicy } from './ports/evidence-port.js';
export { deriveContributionStatus } from './ports/contribution-port.js';
export type {
  ContributionPort,
  ContributionLedgerEntry,
  ContributionLocalState,
  ContributionPublicationState,
  ContributionState,
  ContributionStatus,
  ContributionStatusSnapshot,
} from './ports/contribution-port.js';
export type {
  LocalLearningPort,
  LocalLearningRun,
  LocalLearningSkill,
} from './ports/local-learning-port.js';
export type { SkillsPort, SkillRecord } from './ports/skills-port.js';
export { createJinnPlugin, JINN_PLUGIN_CONTRACT_VERSION, PluginSession } from './plugin.js';
export type {
  CompleteSessionEligibilityInputs,
  CompleteSessionInput,
  JinnPlugin,
  JinnPluginDeps,
  SessionMeta,
  FirstTurnPickupResult,
  ToolCallEvent,
  SessionOutcome,
  SessionEndResult,
  ContributionCompletionReceipt,
  ContributionPreview,
} from './plugin.js';
export { PickupConfigSchema, DEFAULT_PICKUP_CONFIG, parsePickupConfig, TIER_ORDER } from './schemas/pickup-config.js';
export type { PickupConfig, Tier } from './schemas/pickup-config.js';
export {
  deriveSearchTerms,
  classifyPayload,
  dedupeKnowledgeHits,
  scoreKnowledgeHit,
  selectKnowledgeHits,
  rankKnowledgeHits,
  MAX_SELECTED_PACKETS,
} from './pickup.js';
export {
  KNOWLEDGE_PACKET_SCHEMA_VERSION,
  KnowledgePacketSchema,
  KnowledgePacketExcerptSchema,
  DEFAULT_PACKET_CHAR_BUDGET,
  projectKnowledgePacket,
  truncateLineBoundary,
} from './schemas/knowledge-packet.js';
export type {
  KnowledgePacket,
  KnowledgePacketExcerpt,
  KnowledgePacketBudget,
} from './schemas/knowledge-packet.js';
export { deriveEligibility } from './eligibility.js';
export type { EligibilityInputs } from './eligibility.js';
export { foldHistory, foldExplain } from './history.js';
export type { HistoryResult, SessionExplanation, HistoryDeps } from './history.js';
