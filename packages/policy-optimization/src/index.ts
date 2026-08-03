// SPDX-License-Identifier: MIT

/**
 * `@jinn-network/policy-optimization` — public surface.
 *
 * The Policy Optimization product (tier 4). This first sub-unit ships the **core state layer**:
 * the sealed campaign document and its append-only lifecycle journal. The wave engine, admission
 * and proposers, and the archive and CLI arrive in the following sub-units and build on exactly
 * these types.
 *
 * Authority: `docs/superpowers/specs/2026-08-03-policy-optimization-product-design.md` §5–§6.3.
 */

export * from "./tokens.js";
export type {
  CampaignAllocation,
  CampaignBudgets,
  CampaignDocument,
  CampaignObjective,
  CampaignStoppingRule,
  CampaignTarget,
  ExecutionPolicyTuple,
  JsonValue,
  ObjectiveConstraint,
  ObjectiveMethodRef,
  PolicyRef,
  SealedCampaign,
  SeedResolution,
} from "./types.js";

export {
  PolicyOptimizationError,
  type PolicyOptimizationErrorCategory,
  type PolicyOptimizationIssue,
  type ValidationResult,
} from "./errors.js";

// --- product §5.1: the campaign document ---
export {
  checkSeedAgreement,
  isNamespacedExtensionKey,
  parseExactCampaign,
  sealCampaign,
  validateCampaign,
} from "./campaign.js";
export { assertExactPin, axisValuesByteShare, isExactPin } from "./frozen-axes.js";

// --- product §6.3: the committed-and-unrevealed promotion gate ---
export {
  checkExploringEntry,
  type ExploringEntryAdmission,
  type ExploringEntryInput,
  type ExploringEntryRefusal,
  type ExploringEntryResult,
} from "./exploring-entry.js";

// --- product §5.2: the append-only journal ---
export {
  buildJournalEntry,
  journalEntryDigest,
  journalEntryText,
  parseExactJournalLine,
  validateJournalEntry,
  type CampaignJournalEntry,
  type CampaignJournalEntryInput,
  type CampaignJournalEventType,
} from "./journal-entry.js";
export {
  checkEventLegality,
  entersExploring,
  legalEventsIn,
  type CampaignLifecyclePhase,
  type CampaignLifecycleState,
} from "./journal-lifecycle.js";
export {
  appendCampaignEvent,
  createCampaign,
  openCampaign,
  type AppendOptions,
  type CampaignHandle,
  type CreateCampaignInput,
} from "./journal-store.js";

// --- product §8.2: the two observation adapters (substrate §6.3) ---
export {
  type AdapterInputRef,
  type AdapterRefusal,
  type AdapterRefusalReason,
  type AnnouncedVerdict,
  type MirroredProvenance,
  type MirroredRecordRef,
  type MirroredSourceIdentity,
  type ObservedVerdict as AdapterObservedVerdict,
} from "./adapters/types.js";
export {
  curateAnnouncements,
  type CurationAdapterResult,
  type CurationInputRef,
  type CurationObservation,
} from "./adapters/curation-adapter.js";
export {
  deriveOutcomeObservations,
  type AnnouncedPolicyVerdict,
  type DivergentRecordDigestGroup,
  type OutcomesAdapterResult,
  type PolicyFidelityEvidence,
} from "./adapters/outcomes-adapter.js";
