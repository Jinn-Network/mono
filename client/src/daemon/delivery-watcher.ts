import type { ExecutionAdapter } from '../adapters/adapter.js';
import type { Store } from '../store/store.js';
import { emitEvent } from '../observability/emit-event.js';
import { isRecoverableTransactionError } from '../tx-retry.js';
import { SignedEnvelopeSchema } from '../types/envelope.js';
import { validatePayload } from '../types/payloads/index.js';

export class DeliveryWatcherLoop {
  private stopped = false;
  private stopResolve: (() => void) | null = null;
  private stopPromise: Promise<void>;

  constructor(
    private readonly adapter: ExecutionAdapter,
    private readonly store?: Store,
  ) {
    this.stopPromise = new Promise(resolve => {
      this.stopResolve = resolve;
    });
  }

  async run(): Promise<void> {
    while (!this.stopped) {
      try {
        for await (const delivery of this.adapter.watchForDeliveries()) {
          if (this.stopped) break;

          // Attempt to parse the delivery result as a jinn.execution.v1 envelope.
          // result.data is either a JSON-stringified SignedEnvelope (new path) or
          // a legacy plain-text result (old path). Invalid envelopes are logged and
          // skipped so a bad delivery cannot crash the daemon loop.
          let parsedRaw: unknown;
          try {
            parsedRaw = JSON.parse(delivery.result.data);
          } catch {
            // Not JSON — treat as legacy plain-text, skip envelope validation.
            parsedRaw = null;
          }

          if (parsedRaw !== null && typeof parsedRaw === 'object') {
            const maybeEnvelope = parsedRaw as Record<string, unknown>;
            if (maybeEnvelope['schemaVersion'] === 'jinn.execution.v1') {
              try {
                const envelope = SignedEnvelopeSchema.parse(maybeEnvelope);
                validatePayload(envelope.kind, envelope.role, envelope.payload);
                console.error(
                  `[delivery-watcher] envelope ok kind=${envelope.kind} role=${envelope.role} ` +
                  `tier=${envelope.evidenceTier} requestId=${delivery.requestId.slice(0, 10)}...`,
                );
              } catch (err) {
                console.error(
                  `[delivery-watcher] envelope parse/validate failed for ${delivery.requestId.slice(0, 10)}...: ${err}`,
                );
                continue;
              }
            }
            // If schemaVersion is absent the payload is legacy — fall through to normal handling.
          }

          // The adapter handles claim + evaluation creation internally.
          // We just drive the iteration and log for observability.
          const type = delivery.restorationJob.type ?? 'unknown';
          console.error(`[delivery-watcher] Processed ${type} delivery: ${delivery.requestId.slice(0, 10)}...`);
          if (this.store) {
            emitEvent(this.store, {
              kind: type === 'evaluation' ? 'evaluation_submitted' : 'delivery_submitted',
              requestId: delivery.requestId,
              outcome: 'ok',
              detail: `Processed ${type} delivery`,
            }, 'delivery-watcher');
          }
        }
      } catch (err) {
        console.error('[delivery-watcher] Error:', err);
        if (this.store) {
          emitEvent(this.store, {
            kind: 'tick_error',
            outcome: 'failed',
            detail: err instanceof Error ? err.message : String(err),
          }, 'delivery-watcher');
        }
        const delayMs = isRecoverableTransactionError(err) ? 12_000 : 5000;
        await Promise.race([new Promise(r => setTimeout(r, delayMs)), this.stopPromise]);
      }
    }
  }

  stop(): void {
    this.stopped = true;
    this.stopResolve?.();
  }
}
