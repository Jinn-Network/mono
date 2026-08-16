import { describe, it, expect } from 'vitest';
import { mapWithConcurrency, SerialTaskQueue } from '../../src/pilot/pipeline.js';

/** A manually-resolvable promise, for deterministic concurrency assertions. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (err: unknown) => void } {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const tick = (): Promise<void> => new Promise((res) => setImmediate(res));

describe('mapWithConcurrency', () => {
  it('processes every item and never exceeds the concurrency limit', async () => {
    const gates = Array.from({ length: 5 }, () => deferred());
    const active = new Set<number>();
    let peak = 0;
    const done: number[] = [];

    const run = mapWithConcurrency([0, 1, 2, 3, 4], 2, async (item) => {
      active.add(item);
      peak = Math.max(peak, active.size);
      await gates[item]!.promise;
      active.delete(item);
      done.push(item);
    });

    await tick();
    expect([...active]).toEqual([0, 1]);
    gates[0]!.resolve();
    await tick();
    expect([...active]).toEqual([1, 2]);
    for (const gate of gates) gate.resolve();
    await run;

    expect(done.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
  });

  it('propagates a worker rejection', async () => {
    await expect(mapWithConcurrency([1, 2], 2, async (item) => {
      if (item === 2) throw new Error('boom');
    })).rejects.toThrow('boom');
  });

  it('handles an empty item list and a limit above the item count', async () => {
    const seen: number[] = [];
    await mapWithConcurrency([], 4, async () => { seen.push(-1); });
    await mapWithConcurrency([7], 4, async (item) => { seen.push(item); });
    expect(seen).toEqual([7]);
  });
});

describe('SerialTaskQueue', () => {
  it('runs jobs strictly one at a time, in FIFO order', async () => {
    const queue = new SerialTaskQueue();
    const gates = [deferred(), deferred(), deferred()];
    const events: string[] = [];

    for (const [i, gate] of gates.entries()) {
      queue.push(async () => {
        events.push(`start-${i}`);
        await gate.promise;
        events.push(`end-${i}`);
      });
    }

    await tick();
    expect(events).toEqual(['start-0']);
    gates[0]!.resolve();
    await tick();
    expect(events).toEqual(['start-0', 'end-0', 'start-1']);
    gates[1]!.resolve();
    gates[2]!.resolve();
    await queue.drain();
    expect(events).toEqual(['start-0', 'end-0', 'start-1', 'end-1', 'start-2', 'end-2']);
  });

  it('keeps processing after a job rejects, and drain rethrows the first error', async () => {
    const queue = new SerialTaskQueue();
    const ran: number[] = [];
    queue.push(async () => { ran.push(1); });
    queue.push(async () => { throw new Error('grade lane failure'); });
    queue.push(async () => { ran.push(3); });

    await expect(queue.drain()).rejects.toThrow('grade lane failure');
    expect(ran).toEqual([1, 3]);
  });

  it('drain resolves immediately on an empty queue', async () => {
    await expect(new SerialTaskQueue().drain()).resolves.toBeUndefined();
  });
});
