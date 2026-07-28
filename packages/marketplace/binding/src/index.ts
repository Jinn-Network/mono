// @jinn-network/marketplace-binding -- public surface (M0+M1 slice).
//
// `order.ts`/`canonical-json.ts` are deliberately NOT exported here: they seal the binding's own
// backend-internal canonical bytes only (broadcast-intent WAL record, correspondence-assertion
// payload), never a TEP or discovery document family (program §7.1/§7.14/§7.15) -- they are an
// implementation detail, not part of this package's public contract.

// --- the two-generation seam (§5.4, frozen §11.1/§11.6) ---
export { selectGeneration } from "./generation.js";
export type { ContractGeneration, GenerationSelectable } from "./generation.js";

// --- deployed today-mode chain config (Preflight-confirmed) ---
export { BASE_SEPOLIA_TODAY } from "./addresses.js";
export type { MarketplaceChainConfig } from "./addresses.js";

// --- marketplace Attempt-URI derivation: a thin adapter over the protocol export (must #2) ---
export {
  MARKETPLACE_BINDING_NAME,
  deriveMarketplaceAttemptUri,
  normalizeAttemptTuple,
} from "./attempt-uri.js";
export type { MarketplaceAttemptTuple } from "./attempt-uri.js";

// --- the two-party engagement entry (named surface; consumed by the pipeline at Milestone M6) ---
export type { TwoPartyEngagement } from "./two-party-engagement.js";

// --- re-homed mech venue verbs (§14 "declared impact"; M2.1) ---
export {
  computeRawCodecCid,
  decodeRawCodecCidDigestHex,
  uploadRawCodecCid,
} from "./venue/ipfs.js";
export type { IpfsPinPort } from "./venue/ipfs.js";
export { createRegistryPinPort, normalizeIpfsRegistryAddUrl } from "./venue/ipfs-pinfile.js";
export type { FetchLike, RegistryPinPortOptions } from "./venue/ipfs-pinfile.js";
export { ZeroEvidenceHashError, keccakEvidenceHash, rejectZeroEvidenceHash } from "./venue/digest.js";
export { VerdictCode, verdictCodeFromValue } from "./venue/verdict-code.js";
export {
  KNOWN_INNER_ERRORS,
  SafeInnerRevertError,
  decodeSafeInnerRevert,
  formatDecodedRevert,
  formatKnownRevertDetail,
} from "./venue/safe-revert.js";
export { SAFE_ABI, buildSafeSignature, executeSafeTransaction } from "./venue/safe.js";
export type { SafeTransactionParams } from "./venue/safe.js";
export { JINN_ROUTER_V3_ABI } from "./abis/jinn-router-v3.js";
export { TASK_COORDINATOR_ABI } from "./abis/task-coordinator.js";
export { MECH_ABI, MECH_MARKETPLACE_ABI } from "./abis/mech-marketplace.js";

// --- today-mode symmetric honor-or-reject (§6.1, frozen §11.12, ruling §7.20; M2.2) ---
export { honorOrRejectToday } from "./honor-or-reject.js";
export type { HonorOrRejectResult } from "./honor-or-reject.js";

// --- broadcast-intent WAL (honors the pinned 2026-07-24 crash-safety design; M2.3) ---
export {
  BroadcastUncertainError,
  createInMemoryPostingIntentStore,
  recoverPostingIntents,
} from "./broadcast-intent.js";
export type {
  PostingIntent,
  PostingIntentKey,
  PostingIntentRecord,
  PostingIntentStore,
  PostingOutcome,
  ScanForOnChainMatch,
} from "./broadcast-intent.js";

// --- today-mode posting + digest-join (§6.1; M2.3) ---
export { MARKETPLACE_MANIFEST_DIGEST_SENTINEL, encodeCreateTaskCalldata, postTask } from "./posting.js";
export type { PostingPorts, PostingTerms, SafeBroadcastPort } from "./posting.js";
