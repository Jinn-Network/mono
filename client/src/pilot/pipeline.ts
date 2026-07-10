/** Concurrency primitives for the pilot's solve/grade pipeline. Solves fan
 *  out across instances (network/API-bound); grading stays strictly serial —
 *  each eval pulls a multi-GB Docker image and runs under amd64 emulation,
 *  and the eval runner's disk-floor check + prune are not concurrency-safe. */

/** Run `fn` over every item with at most `limit` calls in flight. A rejection
 *  from `fn` propagates to the returned promise — callers that need per-item
 *  containment must catch inside `fn`. */
export async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const concurrency = Math.max(1, Math.min(limit, items.length));
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < items.length) {
        const index = next++;
        await fn(items[index]!, index);
      }
    }),
  );
}

/** Strictly-serial FIFO job queue. A rejecting job never blocks later jobs;
 *  `drain()` waits for every pushed job to settle and then rethrows the first
 *  error. Pushing after `drain()` has settled is unsupported. */
export class SerialTaskQueue {
  private tail: Promise<void> = Promise.resolve();
  private readonly errors: unknown[] = [];

  push(job: () => Promise<void>): void {
    this.tail = this.tail.then(job).catch((err: unknown) => {
      this.errors.push(err);
    });
  }

  async drain(): Promise<void> {
    await this.tail;
    if (this.errors.length > 0) throw this.errors[0];
  }
}
