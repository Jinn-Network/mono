import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { makeRestorationCtx } from '@test/restoration-ctx.js';
import type { DesiredState } from '@/types/desired-state.js';

const fakeIntent: DesiredState = {
  id: 'test-1',
  description: 'fake',
  type: 'restoration',
  window: { startTs: 0, endTs: 1000 },
  spec: { kind: 'prediction.v0' },
} as unknown as DesiredState;

describe('makeRestorationCtx', () => {
  it('creates a context with sensible defaults', () => {
    const ctx = makeRestorationCtx({ intent: fakeIntent });
    expect(ctx.intent).toBe(fakeIntent);
    expect(existsSync(ctx.workingDir)).toBe(true);
    expect(ctx.implStateDir).toBe(ctx.workingDir);  // same dir by default
    expect(ctx.msUntilEndTs()).toBe(0);
    expect(ctx.abort).toBeInstanceOf(AbortSignal);
    expect(typeof ctx.log).toBe('function');
  });

  it('creates separate working/impl-state dirs when separateDirs is set', () => {
    const ctx = makeRestorationCtx({ intent: fakeIntent, separateDirs: true });
    expect(ctx.workingDir).not.toBe(ctx.implStateDir);
    expect(existsSync(ctx.workingDir)).toBe(true);
    expect(existsSync(ctx.implStateDir)).toBe(true);
  });

  it('respects intentCid, msUntilEndTs, abort, log overrides', () => {
    const ac = new AbortController();
    const logged: unknown[] = [];
    const ctx = makeRestorationCtx({
      intent: fakeIntent,
      intentCid: 'bafy-test',
      msUntilEndTs: () => 5000,
      abort: ac.signal,
      log: (event) => { logged.push(event); },
    });
    expect(ctx.intentCid).toBe('bafy-test');
    expect(ctx.msUntilEndTs()).toBe(5000);
    expect(ctx.abort).toBe(ac.signal);
    ctx.log({ level: 'info', msg: 'hi' });
    expect(logged).toEqual([{ level: 'info', msg: 'hi' }]);
  });

  it('attaches extra fields for impls that read test-only ctx properties', () => {
    const ctx = makeRestorationCtx({
      intent: fakeIntent,
      extra: { _testDeps: { fooFn: () => 42 } },
    });
    expect((ctx as unknown as { _testDeps: { fooFn: () => number } })._testDeps.fooFn()).toBe(42);
  });
});
