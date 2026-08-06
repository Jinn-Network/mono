import type { ExecutionAdapter } from '../adapters/adapter.js';
import type { Store } from '../store/store.js';
import { emitEvent } from '../observability/emit-event.js';
import { isRecoverableTransactionError } from '../tx-retry.js';
import { SignedEnvelopeSchema } from '../types/envelope.js';
import { validatePayload } from '../types/payloads/index.js';
import { getSweRebenchV2StateStore, defaultStateDir } from '../solver-types/swe-rebench-v2.js';
import { TaskRunPersistence } from '../store/task-run-persistence.js';

export class DeliveryWatcherLoop {
  private stopped = false;
  private stopResolve: (() => void) | null = null;
  private stopPromise: Promise<void>;
  /** Lazily-built engine persistence, memoized on first use (issue #575). */
  private taskRuns: TaskRunPersistence | null = null;

  constructor(
    private readonly adapter: ExecutionAdapter,
    private readonly store?: Store,
    private readonly sweRebenchV2StateDir: string = defaultStateDir(),
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
                validatePayload(envelope.solverType, envelope.role, envelope.payload);
                console.error(
                  `[delivery-watcher] envelope ok solverType=${envelope.solverType} role=${envelope.role} ` +
                  `tier=${envelope.evidenceTier} requestId=${delivery.requestId.slice(0, 10)}...`,
                );

                // swe-rebench-v2 verdict success hook: when a score=1 verdict arrives,
                // increment successful_count so the generator's post-until-target-successes
                // policy converges. instance_id is sourced from the Task spec on the delivery.
                if (
                  envelope.solverType === 'swe-rebench-v2.v1' &&
                  envelope.role === 'verdict' &&
                  typeof envelope.payload['score'] === 'number' &&
                  envelope.payload['score'] === 1
                ) {
                  const instanceId = delivery.task.spec?.['instance_id'];
                  if (typeof instanceId === 'string' && instanceId.length > 0) {
                    const stateStore = getSweRebenchV2StateStore(this.sweRebenchV2StateDir);
                    stateStore.recordSuccess(instanceId).catch((err) => {
                      console.warn(
                        `[delivery-watcher] swe-rebench-v2 recordSuccess failed for ${instanceId}: ${err instanceof Error ? err.message : err}`,
                      );
                    });
                  }
                }
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
          // On the engine-recovery self-delivery path the adapter rebuilds the
          // task from an in-memory map lost across restart, so task.role is
          // undefined. Fall back to the restart-surviving task_runs row (#575).
          const role = delivery.task.role ?? this.resolveRoleFromStore(delivery.requestId) ?? 'unknown';
          console.error(`[delivery-watcher] Processed ${role} delivery: ${delivery.requestId.slice(0, 10)}...`);
          if (this.store) {
            emitEvent(this.store, {
              kind: role === 'evaluation' ? 'evaluation_submitted' : 'delivery_submitted',
              requestId: delivery.requestId,
              outcome: 'ok',
              detail: `Processed ${role} delivery`,
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

  /**
   * Resolve a delivery's role from the engine's SQLite `task_runs` table when
   * the in-memory task carries no role (engine-recovery self-delivery, #575).
   * Returns null when no store is configured, no matching row exists, or a DB
   * error occurs — the caller then degrades to 'unknown' rather than crashing.
   */
  private resolveRoleFromStore(requestId: string): 'restoration' | 'evaluation' | null {
    if (!this.store) return null;
    try {
      this.taskRuns ??= new TaskRunPersistence(this.store.db);
      return this.taskRuns.getByRequestId(requestId)?.taskRole ?? null;
    } catch {
      return null;
    }
  }

  stop(): void {
    this.stopped = true;
    this.stopResolve?.();
  }
}
