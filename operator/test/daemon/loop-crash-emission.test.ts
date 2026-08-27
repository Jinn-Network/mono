/**
 * Regression for #3037 — loop-crash emissions must carry the `Error.cause`
 * chain.
 *
 * `Daemon.start()` attaches a crash handler to every long-running loop. Those
 * handlers used to build `details: { error: err instanceof Error ? err.message
 * : String(err) }`, which reads only the outermost `.message` and therefore
 * drops the nested cause an RPC/viem failure carries. `emitStructured`
 * sanitizes `details` centrally, so this was never a leak — it was a thinner
 * diagnostic than the adapter's `claim_failed` path produces for the same
 * class of failure. `sanitizeErrorText` walks the chain (and masks URLs with
 * the same host-only dialect), so the handler must go through it.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { emitLoopCrash } from '../../src/daemon/daemon.js';
import { getEventBuffer } from '../../src/events/emitter.js';

function lastEvent() {
  const all = getEventBuffer().snapshot({ limit: 1 });
  return all[0];
}

describe('#3037 — loop-crash emission preserves the cause chain', () => {
  beforeEach(() => {
    getEventBuffer().clear();
  });

  it('walks Error.cause instead of reading only the outermost message', () => {
    const err = new Error('checkpoint tx failed', {
      cause: new Error('HTTP request failed: https://secret-key.example/rpc'),
    });

    emitLoopCrash('checkpoint', 'checkpoint_crashed', err);

    const event = lastEvent();
    expect(event.errorCode).toBe('checkpoint_crashed');
    expect(event.message).toBe('checkpoint loop crashed');
    const detail = String((event.details as Record<string, unknown>).error);
    expect(detail).toContain('checkpoint tx failed');
    // The cause is the part the old `.message`-only read dropped.
    expect(detail).toContain('caused by: HTTP request failed');
    // Still masked by the shared host-only dialect — no second vocabulary.
    expect(detail).not.toContain('secret-key.example/rpc');
  });

  it('still renders a non-Error rejection', () => {
    emitLoopCrash('work', 'work_crashed', 'boom');

    const event = lastEvent();
    expect(event.errorCode).toBe('work_crashed');
    expect((event.details as Record<string, unknown>).error).toBe('boom');
  });
});
