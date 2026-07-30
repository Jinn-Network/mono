// SPDX-License-Identifier: MIT

// @jinn-network/marketplace-venue-base -- public surface. Populated task by task; the facade
// `createBaseVenue` (Task 17) is the supported composition surface (program §5).
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
