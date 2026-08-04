/**
 * Discovery module barrel.
 *
 * Exports the DiscoveryAPI interface, shared types, error class, and the
 * withFallback wrapper. Concrete implementations (OnchainDiscoveryAPI,
 * HttpDiscoveryAPI) live in follow-up tasks and are not exported here until
 * they land.
 */

export type {
  DiscoveryAPI,
  ClaimableTaskCandidate,
  AutopilotDeliveryRole,
  AutopilotDeliveryTaskCandidate,
  AutopilotDeliveryAttemptCandidate,
  AutopilotDeliveryEnvelopeCandidate,
  AutopilotDeliveryCandidateLookup,
  SolverNetLifecycleStatus,
  SolverNetManifestSummary,
  EnvelopeRef,
  CorpusQuery,
  TaskLifecycleEvidence,
  AuthoritativeTaskLifecycle,
  AuthoritativeTaskRow,
  AuthoritativeAttemptRow,
  AuthoritativeVerdictRow,
  AttemptEnvelopeCandidate,
  VerdictEnvelopeCandidate,
} from './types.js';

export { DiscoveryUnavailableError } from './types.js';

export { withFallback } from './with-fallback.js';
export type { WithFallbackOptions } from './with-fallback.js';

export { createOnchainDiscoveryAPI } from './onchain.js';
export type { OnchainDiscoveryAPIOptions, OnchainCursorCache } from './onchain.js';


export { createHttpDiscoveryAPI } from './http.js';
export type { HttpDiscoveryAPIOptions } from './http.js';

export { createDiscoveryAPI } from './factory.js';
export type { DiscoveryFactoryDeps, DiscoveryConfig } from './factory.js';
