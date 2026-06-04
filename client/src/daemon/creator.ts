import type { ExecutionAdapter } from '../adapters/adapter.js';
import type { Task } from '../types/index.js';
import type { Store } from '../store/store.js';
import { PermanentError, TransientError } from '../types/index.js';
import { isRecoverableTransactionError } from '../tx-retry.js';
import { emitEvent } from '../observability/emit-event.js';
import { recordLoopTick } from './loop-heartbeat.js';
import { TaskPostingService } from '../tasks/posting-service.js';
import type { TaskSource } from '../tasks/sources.js';
import { getSweRebenchV2StateStore } from '../solver-types/swe-rebench-v2.js';

export interface ActiveAttempt {
  task: Task;
  attemptNumber: number;
  taskId: string;
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

  async tick(): Promise<string[]> {
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

    const postedTaskIds: string[] = [];
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

        const taskId = postResult.taskId;
        this.attempts.set(state.id, {
          task: state,
          attemptNumber: postResult.attemptNumber,
          taskId,
          status: 'pending',
        });
        postedTaskIds.push(taskId);

        // #802: record the on-chain taskId for swe-rebench-v2 postings so the
        // generator can detect claim-budget exhaustion via the indexer
        // (getInstanceClaimCounts). Mirrors the delivery-watcher recordSuccess
        // hook. Only on a fresh post (idempotent results carry no new task).
        if (state.solverType === 'swe-rebench-v2.v1') {
          const instanceId = state.spec?.['instance_id'];
          if (typeof instanceId === 'string' && instanceId.length > 0) {
            getSweRebenchV2StateStore().recordLastTaskId(instanceId, taskId).catch((err) => {
              console.warn(
                `[creator] swe-rebench-v2 recordLastTaskId failed for ${instanceId}: ${err instanceof Error ? err.message : err}`,
              );
            });
          }
        }
      } catch (err) {
        if (err instanceof TransientError) continue;
        if (err instanceof PermanentError) {
          this.store.setConfigValue(failureKey, String(now));
          console.error(
            `[creator] Permanent create failure for ${state.id}; backing off for ` +
            `${Math.round(CreatorLoop.PERMANENT_FAILURE_BACKOFF_MS / 60000)} min: ${err.message}`,
          );
          continue;
        }
        this.store.setConfigValue(failureKey, String(now));
        console.error(
          `[creator] Create failure for ${state.id}; backing off for ` +
          `${Math.round(CreatorLoop.PERMANENT_FAILURE_BACKOFF_MS / 60000)} min`,
          err,
        );
      }
    }
    return postedTaskIds;
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
      recordLoopTick(this.store, 'creator'); // #1043 loop watchdog
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
