import type { ExecutionAdapter } from '../adapters/adapter.js';

export class DeliveryWatcherLoop {
  private stopped = false;
  private stopResolve: (() => void) | null = null;
  private stopPromise: Promise<void>;

  constructor(private readonly adapter: ExecutionAdapter) {
    this.stopPromise = new Promise(resolve => {
      this.stopResolve = resolve;
    });
  }

  async run(): Promise<void> {
    while (!this.stopped) {
      try {
        for await (const delivery of this.adapter.watchForDeliveries()) {
          if (this.stopped) break;
          // The adapter handles claim + evaluation creation internally.
          // We just drive the iteration and log for observability.
          const type = delivery.desiredState.type ?? 'unknown';
          console.error(`[delivery-watcher] Processed ${type} delivery: ${delivery.requestId.slice(0, 10)}...`);
        }
      } catch (err) {
        console.error('[delivery-watcher] Error:', err);
        await Promise.race([new Promise(r => setTimeout(r, 5000)), this.stopPromise]);
      }
    }
  }

  stop(): void {
    this.stopped = true;
    this.stopResolve?.();
  }
}
