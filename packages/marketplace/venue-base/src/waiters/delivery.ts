// SPDX-License-Identifier: MIT

// Event-watch with poll fallback and cancellation (design §6.1). The Delivery is produced by the
// EMBEDDED backend, not the chain -- `runPipeline` calls this between `submit` and
// `convergeDelivery` -- so the watch surface is TEP's optional `watch` capability and the
// fallback is `observe`. This port owns the timer policy the library deliberately does not.
import type { DeliveryWaitPort, DeliveryWaitResult } from "@jinn-network/marketplace-binding";
import type { AttemptUri, TaskExecutionBackend } from "@jinn-network/task-execution-backend";

export const DEFAULT_DELIVERY_POLL_INTERVAL_MS = 2_000;
export const DEFAULT_DELIVERY_TIMEOUT_MS = 21_600_000;

export interface DeliveryWaiterOptions {
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

async function firstDelivery(
  backend: TaskExecutionBackend,
  attemptUri: AttemptUri,
): Promise<Uint8Array | undefined> {
  const refs = await backend.deliveries(attemptUri);
  if (refs.length === 0) return undefined;
  return backend.fetchDelivery(refs[0]!);
}

export function createDeliveryWaiter(options: DeliveryWaiterOptions = {}): DeliveryWaitPort {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_DELIVERY_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_DELIVERY_TIMEOUT_MS;
  const sleep = options.sleep
    ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  return {
    async waitForDelivery({ attemptUri, backend, signal }): Promise<DeliveryWaitResult> {
      const deadline = Date.now() + timeoutMs;

      if (backend.watch !== undefined) {
        const iterator = backend.watch(attemptUri)[Symbol.asyncIterator]();
        try {
          for (;;) {
            if (signal?.aborted === true) return { ok: false, kind: "cancelled" };
            if (Date.now() >= deadline) return { ok: false, kind: "timeout" };
            const next = await iterator.next();
            if (next.done === true) break;
            if (next.value.type === "network.jinn.task-execution.delivery-recorded.v1") {
              const bytes = await firstDelivery(backend, attemptUri);
              if (bytes !== undefined) return { ok: true, deliveryBytes: bytes };
            }
            if (next.value.type === "network.jinn.task-execution.attempt-terminal.v1") break;
          }
        } catch {
          // A watch stream that faults degrades to polling; it never fails the engagement.
        } finally {
          await iterator.return?.();
        }
      }

      for (;;) {
        if (signal?.aborted === true) return { ok: false, kind: "cancelled" };
        const snapshot = await backend.observe(attemptUri);
        if (snapshot.descriptor.derived.deliveries.length > 0) {
          const bytes = await firstDelivery(backend, attemptUri);
          if (bytes !== undefined) return { ok: true, deliveryBytes: bytes };
        }
        if (snapshot.descriptor.derived.terminal) {
          const bytes = await firstDelivery(backend, attemptUri).catch(() => undefined);
          return bytes === undefined
            ? { ok: false, kind: "backend-terminal", state: snapshot.descriptor.derived.state }
            : { ok: true, deliveryBytes: bytes };
        }
        if (Date.now() >= deadline) return { ok: false, kind: "timeout" };
        await sleep(pollIntervalMs, signal);
      }
    },
  };
}
