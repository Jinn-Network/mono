// SPDX-License-Identifier: MIT

// @jinn-network/marketplace-venue-base -- public surface. The facade `createBaseVenue` (Task 17)
// is the supported composition surface (program §5); every other export is the per-port factory
// underneath it, kept public for hosts that need finer-grained composition.
export { createBaseVenue } from "./create-base-venue.js";
export type { BaseVenue } from "./create-base-venue.js";
export type { BaseVenueConfig } from "./config.js";
export { VENUE_STATE_SCHEMA_VERSION, VenueStateError, openVenueState } from "./state/database.js";
export type { VenueStateDatabase } from "./state/database.js";
export {
  BROADCAST_DEFAULTS,
  classifyBroadcastError,
  flattenError,
  isNonceTooLow,
  isReplacementUnderpriced,
} from "./broadcast/classify.js";
export type { VenueRevertClassification } from "./broadcast/classify.js";
export { bumpFees } from "./broadcast/fees.js";
export type { FeeSnapshot } from "./broadcast/fees.js";
export { createSubmissionLedger } from "./broadcast/ledger.js";
export type { SubmissionKey, SubmissionLedger, SubmissionRecord } from "./broadcast/ledger.js";
export { createBroadcastLock } from "./broadcast/lock.js";
export type { BroadcastLock, BroadcastLockOptions } from "./broadcast/lock.js";
export { evictStuckNonce } from "./broadcast/stuck-nonce.js";
export type { EvictStuckNonceInput } from "./broadcast/stuck-nonce.js";
export {
  createSafeBroadcaster,
  encodePreValidatedSignature,
} from "./broadcast/safe-broadcaster.js";
export type {
  BaseVenueSafeBroadcaster,
  SafeBroadcastOptions,
  SafeBroadcastReceipt,
  SafeBroadcastRequest,
} from "./broadcast/safe-broadcaster.js";
export { createCursorStore } from "./log-source/cursor-store.js";
export type { CursorStore } from "./log-source/cursor-store.js";
export {
  DEFAULT_FINALITY_DEPTH_FALLBACK,
  DEFAULT_LOG_CHUNK_BLOCKS,
  createChainLogSource,
} from "./log-source/chain-log-source.js";
export type {
  ChainLogBatch,
  ChainLogCursor,
  ChainLogSource,
  ChainLogSourceOptions,
} from "./log-source/chain-log-source.js";
export {
  DEFAULT_FINALITY_POLL_INTERVAL_MS,
  DEFAULT_FINALITY_TIMEOUT_MS,
  createFinalityWaiter,
} from "./waiters/finality.js";
export type { FinalityWaiterOptions } from "./waiters/finality.js";
export {
  DEFAULT_DELIVERY_POLL_INTERVAL_MS,
  DEFAULT_DELIVERY_TIMEOUT_MS,
  createDeliveryWaiter,
} from "./waiters/delivery.js";
export type { DeliveryWaiterOptions } from "./waiters/delivery.js";
export {
  createClaimPreflight,
  createClaimWriter,
  decodeAttemptFromLogs,
  encodeClaimTaskCalldata,
} from "./writers/claim.js";
export type { ClaimWriterInput } from "./writers/claim.js";
export {
  DEFAULT_MECH_DELIVER_LOOKBACK_BLOCKS,
  DEFAULT_MULTISEND_ADDRESS,
  createSettlementPorts,
} from "./writers/settlement.js";
export type { SettlementWriterInput } from "./writers/settlement.js";
export { createLifecyclePorts, createReleasePort } from "./writers/lifecycle.js";
export type { LifecycleWriterInput } from "./writers/lifecycle.js";
export { createSqlitePostingIntentStore } from "./intents/intent-store.js";
export {
  DEFAULT_POSTING_SCAN_LOOKBACK_BLOCKS,
  createOnChainPostingScan,
  drainPostingIntents,
} from "./intents/drain.js";
export { createProjectorObservePort } from "./observe/projector-observe.js";
