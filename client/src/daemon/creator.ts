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
  private posted = new Map<string, number>(); // stateId → timestamp of last post
  private attempts = new Map<string, ActiveAttempt>();
  private stopResolve: (() => void) | null = null;
  private stopPromise: Promise<void>;

  // Minimum interval between posting the same desired state (ms).
  // ~20 activities/day needed; each cycle = 4 activities; 5 cycles/day = 1 every ~4.8h.
  // Use 4h to provide safety margin.
  private static readonly REPOST_INTERVAL_MS = 4 * 60 * 60 * 1000;

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
    const now = Date.now();
    for (const state of this.desiredStates) {
      const lastPosted = this.posted.get(state.id);
      if (lastPosted && (now - lastPosted) < CreatorLoop.REPOST_INTERVAL_MS) continue;

      try {
        const prev = this.attempts.get(state.id);
        const attemptNumber = prev ? prev.attemptNumber + 1 : 1;
        const attemptId = `${state.id}/${attemptNumber}`;
        const stateWithAttempt: DesiredState = {
          ...state,
          type: 'restoration',
          attemptId,
          attemptNumber,
        };
        const requestId = await this.adapter.postDesiredState(stateWithAttempt);
        this.posted.set(state.id, now);
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
