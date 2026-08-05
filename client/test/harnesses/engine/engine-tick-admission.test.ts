/**
 * Issue #2407 / spec §5: `engine-tick` is `admission: 'ready-only'` (the
 * claim/work path), but `TaskEngine.runTickLoop` drives its own inline
 * while-loop rather than routing through `daemon/loop-heartbeat.ts`'s
 * `runLoop` — the same shape of gap as the engine-watcher/delivery-watcher
 * caveat, except engine-tick genuinely needs the gate wired in (it isn't
 * inert like the two `always`-admission for-await loops).
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../../../src/store/store.js';
import { TaskEngine, type TaskEngineOptions } from '../../../src/harnesses/engine/engine.js';
import { setDaemonReadiness } from '../../../src/daemon/loop-heartbeat.js';

const engTestRoot = mkdtempSync(join(tmpdir(), 're-eng-tick-admission-'));

function makeOpts(store: Store): TaskEngineOptions {
  return {
    store,
    paths: { workingDirRoot: join(engTestRoot, 'work'), implStateDirRoot: join(engTestRoot, 'impl') },
  };
}

describe('TaskEngine.runTickLoop admission gating (#2407)', () => {
  let store: Store;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new Store(':memory:');
    setDaemonReadiness('ready');
  });

  afterEach(() => {
    vi.useRealTimers();
    setDaemonReadiness('ready');
    store.close();
  });

  it('does not call tick() while daemon readiness is degraded', async () => {
    const engine = new TaskEngine(makeOpts(store));
    const tickSpy = vi.spyOn(engine, 'tick').mockResolvedValue(undefined as never);
    setDaemonReadiness('degraded');

    const running = engine.runTickLoop(1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(tickSpy).not.toHaveBeenCalled();

    engine.stop();
    await vi.advanceTimersByTimeAsync(1000);
    await running;
  });

  it('calls tick() normally when daemon readiness is ready (default)', async () => {
    const engine = new TaskEngine(makeOpts(store));
    const tickSpy = vi.spyOn(engine, 'tick').mockResolvedValue(undefined as never);

    const running = engine.runTickLoop(1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(tickSpy).toHaveBeenCalledTimes(1);

    engine.stop();
    await vi.advanceTimersByTimeAsync(1000);
    await running;
  });

  it('resumes ticking once readiness returns to ready', async () => {
    const engine = new TaskEngine(makeOpts(store));
    const tickSpy = vi.spyOn(engine, 'tick').mockResolvedValue(undefined as never);
    setDaemonReadiness('degraded');

    const running = engine.runTickLoop(1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(tickSpy).not.toHaveBeenCalled();

    setDaemonReadiness('ready');
    await vi.advanceTimersByTimeAsync(1000);
    expect(tickSpy).toHaveBeenCalledTimes(1);

    engine.stop();
    await vi.advanceTimersByTimeAsync(1000);
    await running;
  });
});
