/**
 * E2E-only stand-in for the removed production {@link HarnessLoop}.
 * Full {@link TaskEngine} path requires two-layer claim deps (ClaimRegistry
 * on fork); these phases assert adapter + runner delivery without engine wiring.
 *
 * @internal — do not import from `src/`.
 */
import type { ExecutionAdapter } from '../../src/adapters/adapter.js';
import type { Runner } from '../../src/runner/runner.js';
import type { Store } from '../../src/store/store.js';
import type { TaskRequest } from '../../src/types/index.js';
import { PermanentError, TransientError } from '../../src/types/index.js';
import { isRecoverableTransactionError } from '../../src/tx-retry.js';
import { emitEvent } from '../../src/observability/emit-event.js';

/**
 * @deprecated Production uses {@link TaskEngine}; this class exists for
 * `e2e-validate.ts` only.
 */
export class E2eHarnessLoop {
  private stopped = false;
  private requestIterator: AsyncIterator<TaskRequest> | null = null;
  private stopResolve: (() => void) | null = null;
  private stopPromise: Promise<void>;

  constructor(
    private readonly adapter: ExecutionAdapter,
    private readonly runner: Runner,
    private readonly store: Store,
    private readonly workingDirectory: string = '/tmp',
    private readonly timeoutMs: number = 300_000,
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
      solverType: request.task.solverType,
      outcome: 'ok',
      detail: 'Claimed restoration request',
    }, 'harness');

    try {
      const result = await this.runner.run(request.task, {
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
        solverType: request.task.solverType,
        outcome: 'ok',
        detail: 'Submitted restoration result',
      }, 'harness');
    } catch (err) {
      if (!(err instanceof TransientError)) {
        console.error(`[e2e-legacy-harness] Failed to restore ${request.requestId}:`, err);
        emitEvent(this.store, {
          kind: 'tick_error',
          requestId: request.requestId,
          solverType: request.task.solverType,
          outcome: 'failed',
          detail: err instanceof Error ? err.message : String(err),
        }, 'harness');
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
          console.error('[e2e-legacy-harness] Error:', err);
          emitEvent(this.store, {
            kind: 'tick_error',
            outcome: 'failed',
            detail: err instanceof Error ? err.message : String(err),
          }, 'harness');
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
