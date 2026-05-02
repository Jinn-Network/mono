import type { ExecutionAdapter } from '../adapters/adapter.js';
import type { Task, RequestId } from '../types/index.js';
import type { Store } from '../store/store.js';
import { PermanentError, TransientError } from '../types/index.js';
import { isRecoverableTransactionError } from '../tx-retry.js';
import { emitEvent } from '../observability/emit-event.js';
import { TaskPostingService } from '../tasks/posting-service.js';
import type { TaskSource } from '../tasks/sources.js';

export interface ActiveAttempt {
  task: Task;
  attemptNumber: number;
  restorationRequestId: string;
  status: 'pending' | 'resolved';
}

export class CreatorLoop {
  private stopped = false;
  private attempts = new Map<string, ActiveAttempt>();
  private stopResolve: (() => void) | null = null;
  private stopPromise: Promise<void>;
  private readonly postingService: TaskPostingService;

  private static readonly PERMANENT_FAILURE_BACKOFF_MS = 30 * 60 * 1000;

  private static failureCacheKey(state: Task, safeAddress?: string): string {
    const prefix = safeAddress ? `create_failed:${safeAddress}` : 'create_failed';
    return `${prefix}:${state.id}`;
  }

  constructor(
    private readonly adapter: ExecutionAdapter,
    private readonly taskSources: TaskSource[],
    private readonly store: Store,
    private readonly safeAddress?: string,
  ) {
    this.postingService = new TaskPostingService(adapter, store);
    this.stopPromise = new Promise(resolve => {
      this.stopResolve = resolve;
    });
  }

  async tick(): Promise<RequestId | null> {
    const now = Date.now();
    const candidates = [];
    for (const source of this.taskSources) {
      try {
        const result = await source.collect(new Date(now));
        candidates.push(...result);
      } catch (err) {
        console.error(`[creator] source ${source.sourceKey} error (skipping this tick):`, err);
      }
    }

    for (const candidate of candidates) {
      const state = candidate.task;
      const failureKey = CreatorLoop.failureCacheKey(state, this.safeAddress);
      const failedAt = this.store.getConfigValue(failureKey);
      if (failedAt) {
        const ts = Number(failedAt);
        if (Number.isFinite(ts) && now - ts < CreatorLoop.PERMANENT_FAILURE_BACKOFF_MS) {
          continue;
        }
      }

      try {
        const postResult = await this.postingService.postCandidate(candidate, {
          creatorSafeAddress: this.safeAddress,
        });
        if (postResult.idempotent) continue;

        const requestId = postResult.requestId;
        this.attempts.set(state.id, {
          task: state,
          attemptNumber: postResult.attemptNumber,
          restorationRequestId: requestId,
          status: 'pending',
        });
        return requestId;
      } catch (err) {
        if (err instanceof TransientError) continue;
        if (err instanceof PermanentError) {
          this.store.setConfigValue(failureKey, String(now));
          console.error(
            `[creator] Permanent create failure for ${state.id}; backing off for ` +
            `${Math.round(CreatorLoop.PERMANENT_FAILURE_BACKOFF_MS / 60000)} min: ${err.message}`,
          );
        }
        throw err;
      }
    }
    return null;
  }

  async run(): Promise<void> {
    while (!this.stopped) {
      let delayMs = 5000;
      try {
        await this.tick();
      } catch (err) {
        console.error('[creator] Error:', err);
        emitEvent(this.store, {
          kind: 'tick_error',
          outcome: 'failed',
          detail: err instanceof Error ? err.message : String(err),
        }, 'creator');
        delayMs = isRecoverableTransactionError(err) ? 12_000 : 8000;
      }
      await Promise.race([
        new Promise(r => setTimeout(r, delayMs)),
        this.stopPromise,
      ]);
    }
  }

  stop(): void {
    this.stopped = true;
    this.stopResolve?.();
  }
}
