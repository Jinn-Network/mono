// SPDX-License-Identifier: Apache-2.0

import type { AttemptUri } from "@jinn-network/task-execution-backend";

interface ObservationWaiter {
  readonly afterSequence: string;
  readonly resolve: () => void;
}

/** In-memory wakeups for durable journal tails; authority remains on-disk observation replay. */
export class ObservationWatchRegistry {
  private readonly waiters = new Map<AttemptUri, Set<ObservationWaiter>>();

  wait(attempt: AttemptUri, afterSequence: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new Error("watch cancelled"));
    return new Promise<void>((resolve, reject) => {
      const waiter: ObservationWaiter = {
        afterSequence,
        resolve: () => {
          cleanup();
          resolve();
        },
      };
      const onAbort = (): void => {
        cleanup();
        reject(new Error("watch cancelled"));
      };
      const cleanup = (): void => {
        signal.removeEventListener("abort", onAbort);
        this.waiters.get(attempt)?.delete(waiter);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      const bucket = this.waiters.get(attempt) ?? new Set<ObservationWaiter>();
      bucket.add(waiter);
      this.waiters.set(attempt, bucket);
    });
  }

  notify(attempt: AttemptUri, latestSequence: string): void {
    const bucket = this.waiters.get(attempt);
    if (bucket === undefined) return;
    for (const waiter of [...bucket]) {
      if (latestSequence > waiter.afterSequence) waiter.resolve();
    }
  }

  closeAll(): void {
    for (const bucket of this.waiters.values()) {
      for (const waiter of bucket) waiter.resolve();
    }
    this.waiters.clear();
  }
}
