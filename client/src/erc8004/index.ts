/**
 * ERC-8004 surface — Jinn's typed wrappers around the three deployed canonical
 * registries (Identity, Reputation, Validation). One package owns ABIs,
 * addresses, and clients; downstream code imports from the barrel only.
 *
 * Spec: `docs/superpowers/specs/2026-04-27-erc-8004-entity-model-design.md`.
 */

// ── Addresses ──────────────────────────────────────────────────────────────────
export {
  REPUTATION_REGISTRY_ADDRESSES,
  getReputationRegistryAddress,
  VALIDATION_REGISTRY_ADDRESSES,
  getValidationRegistryAddress,
} from './addresses.js';

// ── ABIs ───────────────────────────────────────────────────────────────────────
export {
  IDENTITY_REGISTRY_SET_METADATA_ABI,
  PAYLOAD_TUPLE,
  REPUTATION_REGISTRY_ABI,
  VALIDATION_REGISTRY_ABI,
} from './abis.js';

// ── IdentityRegistry (publisher + agent resolver) ──────────────────────────────
export {
  IdentityPublisher,
  PayloadValidationError,
  buildMetadataKey,
  encodeExecutionPayload,
  validatePayload,
  resolveAgentIdForManifest,
  type ContentKind,
  type ExecutionPayload,
  type ExecutionTier,
  type IdentityPublisherConfig,
  type PublishContentArgs,
  type ResolveAgentIdArgs,
  type ResolvedAgent,
} from './identity.js';

// ── ReputationRegistry (client + feedback hook) ────────────────────────────────
export {
  ReputationRegistryClient,
  ZERO_HASH,
  mapVerdictToScore,
  submitEvaluatorFeedback,
  type FeedbackId,
  type FeedbackHookOutcome,
  type FeedbackRecord,
  type FeedbackSummary,
  type GiveFeedbackArgs,
  type EvaluatorVerdict,
  type ReputationRegistryConfig,
  type RespondToFeedbackArgs,
  type RestorerExecutionRef,
  type RevokeFeedbackArgs,
  type ScoreMapping,
} from './reputation.js';

// ── ValidationRegistry ─────────────────────────────────────────────────────────
export {
  ValidationRegistryClient,
  type ValidationRecord,
  type ValidationRegistryConfig,
  type ValidationStatus,
} from './validation.js';

// ── Subgraph stub (will move to its own module once the V2 schema lands) ──────
export {
  getMetadataValue,
  queryArtifacts,
  queryNodes,
  type SubgraphConfig,
  type SubgraphResult,
} from './subgraph.js';
