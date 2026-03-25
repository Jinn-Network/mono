import { randomUUID } from 'node:crypto';
import type { ExecutionAdapter } from '../adapter.js';
import type {
  DesiredState,
  RequestId,
  RestorationRequest,
  RestorationResult,
  DeliveredResult,
} from '../../types/index.js';

export class LocalAdapter implements ExecutionAdapter {
  readonly name = 'local';

  private requests = new Map<RequestId, RestorationRequest>();
  private pendingRequests: RestorationRequest[] = [];
  private deferredEvalRequests: RestorationRequest[] = [];
  private pendingDeliveries: DeliveredResult[] = [];
  private requestWaiters: Array<(req: RestorationRequest) => void> = [];
  private deliveryWaiters: Array<(del: DeliveredResult) => void> = [];
  private deliveredRequestIds = new Set<RequestId>();
  private stopped = false;

  async initialize(): Promise<void> {
    // No-op for local
  }

  async postDesiredState(state: DesiredState): Promise<RequestId> {
    const requestId = randomUUID();

    // Create restoration request
    const restorationState: DesiredState = {
      ...state,
      type: state.type ?? 'restoration',
    };
    const request: RestorationRequest = {
      requestId,
      desiredState: restorationState,
    };
    this.requests.set(requestId, request);

    if (this.requestWaiters.length > 0) {
      this.requestWaiters.shift()!(request);
    } else {
      this.pendingRequests.push(request);
    }

    // Create linked evaluation request
    const evalRequestId = randomUUID();
    const evaluationState: DesiredState = {
      ...state,
      type: 'evaluation',
      restorationRequestId: requestId,
    };
    const evalRequest: RestorationRequest = {
      requestId: evalRequestId,
      desiredState: evaluationState,
    };
    this.requests.set(evalRequestId, evalRequest);
    // Evaluation requests are deferred — only yielded after restoration is delivered
    this.deferredEvalRequests.push(evalRequest);

    return requestId;
  }

  async *watchForRequests(): AsyncIterable<RestorationRequest> {
    while (!this.stopped) {
      // Check if any deferred evaluation requests are now ready
      const stillDeferred: RestorationRequest[] = [];
      for (const evalReq of this.deferredEvalRequests) {
        const restorationId = evalReq.desiredState.restorationRequestId;
        if (restorationId && this.deliveredRequestIds.has(restorationId)) {
          // Restoration delivered — yield evaluation request
          if (this.requestWaiters.length > 0) {
            this.requestWaiters.shift()!(evalReq);
          } else {
            this.pendingRequests.push(evalReq);
          }
        } else {
          stillDeferred.push(evalReq);
        }
      }
      this.deferredEvalRequests = stillDeferred;

      if (this.pendingRequests.length > 0) {
        yield this.pendingRequests.shift()!;
      } else {
        const req = await new Promise<RestorationRequest>((resolve) => {
          this.requestWaiters.push(resolve);
        });
        if (!this.stopped) yield req;
      }
    }
  }

  async claimRequest(_requestId: RequestId): Promise<void> {
    // Always succeeds in local mode
  }

  async submitResult(requestId: RequestId, result: RestorationResult): Promise<void> {
    const request = this.requests.get(requestId);
    if (!request) throw new Error(`Unknown request: ${requestId}`);

    this.deliveredRequestIds.add(requestId);

    const delivery: DeliveredResult = {
      requestId,
      desiredState: request.desiredState,
      result,
      deliveryMechAddress: 'local',
    };

    if (this.deliveryWaiters.length > 0) {
      this.deliveryWaiters.shift()!(delivery);
    } else {
      this.pendingDeliveries.push(delivery);
    }

    // Check if any deferred evaluation requests are now ready
    const stillDeferred: RestorationRequest[] = [];
    for (const evalReq of this.deferredEvalRequests) {
      const restorationId = evalReq.desiredState.restorationRequestId;
      if (restorationId && this.deliveredRequestIds.has(restorationId)) {
        if (this.requestWaiters.length > 0) {
          this.requestWaiters.shift()!(evalReq);
        } else {
          this.pendingRequests.push(evalReq);
        }
      } else {
        stillDeferred.push(evalReq);
      }
    }
    this.deferredEvalRequests = stillDeferred;
  }

  async *watchForDeliveries(): AsyncIterable<DeliveredResult> {
    while (!this.stopped) {
      if (this.pendingDeliveries.length > 0) {
        yield this.pendingDeliveries.shift()!;
      } else {
        const del = await new Promise<DeliveredResult>((resolve) => {
          this.deliveryWaiters.push(resolve);
        });
        if (!this.stopped) yield del;
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    // Resolve any pending waiters so loops can exit
    for (const waiter of this.requestWaiters) {
      waiter({ requestId: '', desiredState: { id: '', description: '' } });
    }
    for (const waiter of this.deliveryWaiters) {
      waiter({ requestId: '', desiredState: { id: '', description: '' }, result: { data: '' }, deliveryMechAddress: '' });
    }
    this.requestWaiters = [];
    this.deliveryWaiters = [];
  }
}
