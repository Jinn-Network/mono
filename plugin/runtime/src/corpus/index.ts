// SPDX-License-Identifier: Apache-2.0

export {
  DEFAULT_CORPUS_PRODUCER_PURPOSE,
  composeAdmission,
  createDeniedProducerAdmission,
  createFollowedSourceAdmission,
  createTrustPolicyAdmission,
  type AdmissionDecision,
  type AdmissionRejectionReason,
  type CorpusAdmission,
  type PolicyChainVerifier,
  type TrustPolicyAdmissionOptions,
} from "./admission.js";
export {
  FAMILY_BY_RECORD_KIND,
  adaptAnnouncementEntry,
  sourceIdOf,
  type AnnouncementAdaptation,
  type ExcludedAnnouncement,
  type ExclusionReason,
} from "./announcements.js";
export {
  UNVERIFIED_CHAIN_ACKNOWLEDGEMENT,
  createDriverChainVerification,
  createRejectingChainVerification,
  createUnverifiedChainVerification,
  type ChainVerification,
  type ChainVerificationInput,
  type ChainVerificationOutcome,
  type UnverifiedChainAcknowledgement,
} from "./chain-verification.js";
export {
  createCorpusCapability,
  type CorpusCapability,
  type CreateCorpusCapabilityOptions,
} from "./capability.js";
export {
  CORPUS_ERROR_CODES,
  CorpusMirrorError,
  type CorpusErrorCode,
} from "./errors.js";
export {
  HIGH_WATER_MARK_FORMAT,
  createFileHighWaterMarkStore,
} from "./high-water-mark.js";
export {
  CORPUS_SYNC_LOCK_FORMAT,
  tryAcquireSyncLock,
  type CorpusSyncLock,
} from "./lock.js";
export {
  createCorpusMirror,
  type CorpusMirror,
  type CreateCorpusMirrorOptions,
  type MirrorSourceSyncReport,
  type MirrorSyncOutcome,
  type MirrorSyncStatus,
} from "./mirror.js";
export {
  createCorpusReader,
  producerIdOf,
  type CorpusReadOptions,
  type CorpusReadPage,
  type CorpusReadQuery,
  type CorpusReader,
  type CorpusRecordCandidate,
  type CreateCorpusReaderOptions,
  type MirrorSourceStatus,
} from "./read.js";
export {
  MIRROR_REPOSITORY_ID,
  createCorpusRepositoryResolver,
  createMirroringRepository,
  createServingPlaneRepository,
} from "./repositories.js";
export {
  createCorpusRetrieval,
  type CorpusFetchOptions,
  type CorpusFetchOutcome,
  type CorpusRetrieval,
  type CreateCorpusRetrievalOptions,
} from "./retrieve.js";
export {
  CORPUS_PROJECTOR_VERSION,
  openCorpusMirrorStore,
  withCorpusMirrorStore,
  type CorpusMirrorStore,
  type OpenCorpusMirrorStoreOptions,
} from "./store.js";
