import type { ExecutionAdapter } from '../adapters/adapter.js';
import type { Runner } from '../runner/runner.js';
import type { Store } from '../store/store.js';
import { PermanentError, TransientError } from '../types/index.js';
import { isRecoverableTransactionError } from '../tx-retry.js';
import type { RestorationRequest } from '../types/index.js';
import { emitEvent } from '../observability/emit-event.js';

export class RestorerLoop {
  private stopped = false;
  private requestIterator: AsyncIterator<RestorationRequest> | null = null;
  private stopResolve: (() => void) | null = null;
  private stopPromise: Promise<void>;

  constructor(
    private readonly adapter: ExecutionAdapter,
    private readonly runner: Runner,
    private readonly store: Store,
    private readonly workingDirectory: string = '/tmp',
    private readonly timeoutMs: number = 300000,
    private readonly daemonApiUrl?: string,
  ) {
    this.stopPromise = new Promise(resolve => {
      this.stopResolve = resolve;
    });
  }

  async processOne(): Promise<boolean> {
    if (!this.requestIterator) {
      this.requestIterator = this.adapter.watchForRequests()[Symbol.asyncIterator]();
    }

    const { value: request, done } = await this.requestIterator.next();
    if (done || !request || !request.requestId) return false;

    try {
      await this.adapter.claimRequest(request.requestId);
    } catch (err) {
      if (err instanceof PermanentError) {
        return true;
      }
      throw err;
    }

    this.store.recordOwnActivity(request.requestId, 'claimed');
    emitEvent(this.store, {
      kind: 'request_claimed',
      requestId: request.requestId,
      specKind: request.desiredState.spec?.kind,
      outcome: 'ok',
      detail: 'Claimed restoration request',
    }, 'restorer');

    try {
      const result = await this.runner.run(request.desiredState, {
        requestId: request.requestId,
        workingDirectory: this.workingDirectory,
        timeoutMs: this.timeoutMs,
        storePath: this.store.path,
        daemonApiUrl: this.daemonApiUrl,
      });

      await this.adapter.submitResult(request.requestId, result);
      this.store.recordOwnActivity(request.requestId, 'delivered');
      emitEvent(this.store, {
        kind: 'delivery_submitted',
        requestId: request.requestId,
        specKind: request.desiredState.spec?.kind,
        outcome: 'ok',
        detail: 'Submitted restoration result',
      }, 'restorer');
    } catch (err) {
      if (!(err instanceof TransientError)) {
        console.error(`[restorer] Failed to restore ${request.requestId}:`, err);
        emitEvent(this.store, {
          kind: 'tick_error',
          requestId: request.requestId,
          specKind: request.desiredState.spec?.kind,
          outcome: 'failed',
          detail: err instanceof Error ? err.message : String(err),
        }, 'restorer');
      }
    }

    return true;
  }

  async run(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.processOne();
      } catch (err) {
        if (err instanceof TransientError) {
          await Promise.race([new Promise(r => setTimeout(r, 5000)), this.stopPromise]);
        } else {
          console.error('[restorer] Error:', err);
          emitEvent(this.store, {
            kind: 'tick_error',
            outcome: 'failed',
            detail: err instanceof Error ? err.message : String(err),
          }, 'restorer');
          const delayMs = isRecoverableTransactionError(err) ? 15_000 : 10_000;
          await Promise.race([new Promise(r => setTimeout(r, delayMs)), this.stopPromise]);
        }
      }
    }
  }

  stop(): void {
    this.stopped = true;
    this.stopResolve?.();
  }
}
