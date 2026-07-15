// packages/plugin/src/index.ts
// Public entry — grows incrementally as ports/schemas/factory land (S1-F1).
export type { PortResult } from './outcome.js';
export { ok, degraded, unavailable, valueOr, unwrap } from './outcome.js';
export { EPISODE_SCHEMA_VERSION, EpisodeV1Schema } from './schemas/episode.js';
export type { EpisodeV1 } from './schemas/episode.js';
export { KnowledgeHitSchema } from './schemas/knowledge-hit.js';
export type { KnowledgeHit } from './schemas/knowledge-hit.js';
export { EligibilityVerdictSchema } from './schemas/eligibility-verdict.js';
export type { EligibilityVerdict } from './schemas/eligibility-verdict.js';
export { SessionSummarySchema } from './schemas/session-summary.js';
export type { SessionSummary } from './schemas/session-summary.js';
export { HistoryEntrySchema } from './schemas/history-entry.js';
export type { HistoryEntry } from './schemas/history-entry.js';
export type { CorpusPort } from './ports/corpus-port.js';
export type { EvidencePort, EvidenceListQuery, EvidenceRetentionPolicy } from './ports/evidence-port.js';
export type { ContributionPort, ContributionLedgerEntry } from './ports/contribution-port.js';
export type { LocalLearningPort, LocalLearningRun } from './ports/local-learning-port.js';
export type { SkillsPort, SkillRecord } from './ports/skills-port.js';
export { createJinnPlugin, PluginSession } from './plugin.js';
export type {
  JinnPlugin,
  JinnPluginDeps,
  SessionMeta,
  FirstTurnPickupResult,
  ToolCallEvent,
  SessionOutcome,
  SessionEndResult,
} from './plugin.js';
export { PickupConfigSchema, DEFAULT_PICKUP_CONFIG, parsePickupConfig, TIER_ORDER } from './schemas/pickup-config.js';
export type { PickupConfig, Tier } from './schemas/pickup-config.js';
export { deriveTerms, tierAtLeast, classifyPayload, hitToCandidate, decidePickup } from './pickup.js';
export type { PickupCandidate, PickupDecision } from './pickup.js';
export { deriveEligibility } from './eligibility.js';
export type { EligibilityInputs } from './eligibility.js';
export { foldHistory, foldExplain } from './history.js';
export type { HistoryResult, SessionExplanation, HistoryDeps } from './history.js';
