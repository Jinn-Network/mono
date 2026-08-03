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
  PAYLOAD_TUPLE_V2,
  MANIFEST_PAYLOAD_TUPLE,
  REPUTATION_REGISTRY_ABI,
  VALIDATION_REGISTRY_ABI,
} from './abis.js';

// ── IdentityRegistry (publisher + agent resolver) ──────────────────────────────
export {
  IdentityPublisher,
  ManifestReceiptConfirmationError,
  PayloadValidationError,
  buildMetadataKey,
  parseMetadataKey,
  contentKindForAnchor,
  encodeExecutionPayload,
  encodeExecutionPayloadV2,
  validatePayload,
  validatePayloadV2,
  codeDigestSha256ToBytes32,
  modeStringToFlag,
  protocolExecutorMode,
  resolveAgentIdForManifest,
  type ContentKind,
  type ExecutionPayload,
  type ExecutionPayloadV2,
  type ExecutionModeFlag,
  type ExecutionTier,
  type IdentityPublisherConfig,
  type PublishContentArgs,
  type PublishContentResult,
  type PublishContentV2Args,
  type ManifestPublishArgs,
  type ResolveAgentIdArgs,
  type ResolvedAgent,
} from './identity.js';
export {
  createPublisherSafeResolver,
  type PublisherSafeResolverOptions,
  type RegistryReadClient,
} from './publisher-safe-resolver.js';

// ── Manifest batch anchors ───────────────────────────────────────────────────
export {
  hashLeaf,
  merkleRoot,
  merkleProof,
  verifyMerkleProof,
  type MerkleProof,
} from './merkle.js';
export {
  MANIFEST_METADATA_KEY_PREFIX,
  ManifestPayloadValidationError,
  buildManifestMetadataKey,
  parseManifestMetadataKey,
  encodeManifestPayload,
  decodeManifestPayload,
  validateManifestPayload,
  type ManifestPayload,
} from './manifest-registry.js';
export {
  ManifestAnchorNotFoundError,
  ManifestContentAddressMismatchError,
  ManifestRootMismatchError,
  readManifestAnchor,
  fetchManifest,
  enumerateMembers,
  proveMember,
  verifyMember,
  type ManifestAnchor,
  type ManifestAnchorReadDeps,
  type ManifestFetchDeps,
} from './manifest-consumer.js';

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
  type HarnessExecutionRef,
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
