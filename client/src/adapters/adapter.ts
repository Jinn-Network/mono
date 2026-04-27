import type {
  RestorationJob,
  RequestId,
  RestorationRequest,
  RestorationResult,
  DeliveredResult,
} from '../types/index.js';

export interface ExecutionAdapter {
  readonly name: string;

  initialize(): Promise<void>;

  // Creator
  postRestorationJob(state: RestorationJob): Promise<RequestId>;

  /**
   * Optional: returns the IPFS CID of the most recently posted intent payload.
   * Populated by adapters that upload to IPFS as part of `postDesiredState`
   * (e.g. MechAdapter). Used by the posting service for ERC-8004 registration.
   * Returns undefined for adapters that do not upload (e.g. LocalAdapter).
   */
  getLastPostedIntentCid?(): string | undefined;

  // Restorer
  watchForRequests(): AsyncIterable<RestorationRequest>;
  claimRequest(requestId: RequestId): Promise<void>;
  submitResult(requestId: RequestId, result: RestorationResult): Promise<void>;

  // Deliveries
  watchForDeliveries(): AsyncIterable<DeliveredResult>;

  // Lifecycle
  stop(): Promise<void>;
}
