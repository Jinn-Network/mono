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

  // Restorer
  watchForRequests(): AsyncIterable<RestorationRequest>;
  claimRequest(requestId: RequestId): Promise<void>;
  submitResult(requestId: RequestId, result: RestorationResult): Promise<void>;

  // Deliveries
  watchForDeliveries(): AsyncIterable<DeliveredResult>;

  // Lifecycle
  stop(): Promise<void>;
}
