import type { ExecutionAdapter } from '../adapters/adapter.js';
import type { DesiredState, RequestId } from '../types/index.js';
import type { Store } from '../store/store.js';
import { TransientError } from '../types/index.js';

export interface ActiveAttempt {
  desiredState: DesiredState;
  attemptNumber: number;
  restorationRequestId: string;
  status: 'pending' | 'resolved';
}

export class CreatorLoop {
  private stopped = false;
  private posted = new Set<string>();
  private attempts = new Map<string, ActiveAttempt>();
  private stopResolve: (() => void) | null = null;
  private stopPromise: Promise<void>;

  constructor(
    private readonly adapter: ExecutionAdapter,
    private readonly desiredStates: DesiredState[],
    private readonly store: Store,
  ) {
    this.stopPromise = new Promise(resolve => {
      this.stopResolve = resolve;
    });
  }

  async tick(): Promise<RequestId | null> {
    for (const state of this.desiredStates) {
      if (this.posted.has(state.id)) continue;
      try {
        const attemptNumber = 1;
        const attemptId = `${state.id}/${attemptNumber}`;
        const stateWithAttempt: DesiredState = {
          ...state,
          type: 'restoration',
          attemptId,
          attemptNumber,
        };
        const requestId = await this.adapter.postDesiredState(stateWithAttempt);
        this.posted.add(state.id);
        this.attempts.set(state.id, {
          desiredState: state,
          attemptNumber,
          restorationRequestId: requestId,
          status: 'pending',
        });
        this.store.recordOwnActivity(requestId, 'created');
        return requestId;
      } catch (err) {
        if (err instanceof TransientError) continue;
        throw err;
      }
    }
    return null;
  }

  async run(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.tick();
      } catch (err) {
        console.error('[creator] Error:', err);
      }
      await Promise.race([
        new Promise(r => setTimeout(r, 5000)),
        this.stopPromise,
      ]);
    }
  }

  stop(): void {
    this.stopped = true;
    this.stopResolve?.();
  }
}
