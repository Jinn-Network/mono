import type { ExecutionAdapter } from '../adapters/adapter.js';
import type { DesiredState, RequestId } from '../types/index.js';
import type { Store } from '../store/store.js';
import { PermanentError, TransientError } from '../types/index.js';
import { isRecoverableTransactionError } from '../tx-retry.js';
import { emitEvent } from '../observability/emit-event.js';

export interface ActiveAttempt {
  desiredState: DesiredState;
  attemptNumber: number;
  restorationRequestId: string;
  status: 'pending' | 'resolved';
}

/** Returns a freshly-built DesiredState for this tick, or null to skip. */
export type IntentGenerator = () => Promise<DesiredState | null>;

export class CreatorLoop {
  private stopped = false;
  private posted = new Map<string, number>(); // stateId → timestamp of last post (in-memory fast-path)
  private attempts = new Map<string, ActiveAttempt>();
  private stopResolve: (() => void) | null = null;
  private stopPromise: Promise<void>;
  private readonly generators: IntentGenerator[];

  // Minimum interval between posting the same desired state (ms).
  // ~20 activities/day needed; each cycle = 4 activities; 5 cycles/day = 1 every ~4.8h.
  // Use 4h to provide safety margin.
  private static readonly REPOST_INTERVAL_MS = 4 * 60 * 60 * 1000;
  private static readonly PERMANENT_FAILURE_BACKOFF_MS = 30 * 60 * 1000;

  /** SQLite config key for durable idempotency across daemon restarts. */
  private static cacheKey(state: DesiredState, safeAddress?: string): string {
    const prefix = safeAddress ? `created_intent:${safeAddress}` : 'created_intent';
    return `${prefix}:${state.id}`;
  }

  private static failureCacheKey(state: DesiredState, safeAddress?: string): string {
    const prefix = safeAddress ? `create_failed:${safeAddress}` : 'create_failed';
    return `${prefix}:${state.id}`;
  }

  constructor(
    private readonly adapter: ExecutionAdapter,
    private readonly desiredStates: DesiredState[],
    private readonly store: Store,
    generators: IntentGenerator[] = [],
    private readonly safeAddress?: string,
  ) {
    this.generators = generators;
    this.stopPromise = new Promise(resolve => {
      this.stopResolve = resolve;
    });
  }

  async tick(): Promise<RequestId | null> {
    const now = Date.now();

    // Compose candidates: static configured states + freshly generated ones.
    // Generators returning null are filtered (e.g. Chainlink read failure).
    const generated: DesiredState[] = [];
    for (const gen of this.generators) {
      try {
        const result = await gen();
        if (result) generated.push(result);
      } catch (err) {
        console.error('[creator] generator error (skipping this tick):', err);
      }
    }
    const candidates = [...this.desiredStates, ...generated];

    for (const state of candidates) {
      // In-memory fast-path: posted within the 4h window → skip.
      const lastPosted = this.posted.get(state.id);
      if (lastPosted && (now - lastPosted) < CreatorLoop.REPOST_INTERVAL_MS) continue;

      // Durable idempotency: SQLite cache survives daemon restarts. If we
      // already posted this state.id before (and it's still within the repost
      // window OR the id is stable-per-hour like auto-generators), skip.
      const cacheKey = CreatorLoop.cacheKey(state, this.safeAddress);
      const cachedRequestId = this.store.getConfigValue(cacheKey);
      if (cachedRequestId) {
        // Refresh the in-memory tracker so subsequent ticks hit the fast-path.
        this.posted.set(state.id, now);
        continue;
      }
      const failureKey = CreatorLoop.failureCacheKey(state, this.safeAddress);
      const failedAt = this.store.getConfigValue(failureKey);
      if (failedAt) {
        const ts = Number(failedAt);
        if (Number.isFinite(ts) && now - ts < CreatorLoop.PERMANENT_FAILURE_BACKOFF_MS) {
          continue;
        }
      }

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
        emitEvent(this.store, {
          kind: 'intent_posted',
          requestId,
          specKind: state.spec?.kind,
          outcome: 'ok',
          detail: `Posted intent for desired state ${state.id}`,
        }, 'creator');
        this.store.setConfigValue(cacheKey, requestId);
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
